# RM2100 campus-fix 固件

红米 RM AC2100（MediaTek MT7621A，128MB RAM / 16MB flash）专用 OpenWrt 固件，
内置**校园网多设备检测规避**套件，通过 GitHub Actions 云端构建，本机无需 Linux 环境。

**当前固件版本：v2.3.1**（刷入后 `cat /etc/campus-fix-version` 查询）

## 功能总览

| 检测手段 | 对策 | 位置 / 操作 |
|---|---|---|
| TTL 检测 | WAN 出方向 IPv4 TTL / IPv6 hoplimit 强制 128（Windows 指纹；可改 64） | `10-campus-ttl-fix.nft` `campus_ttl_postrouting` |
| IP-ID 熵检测 | 每 flow 稳定 IP-ID（五元组 hash），消除多 OS 混合指纹 | 同文件 `campus_ipid_postrouting` |
| DSCP/QoS 相关性 | 出方向 DSCP 归一 CS0（ECN 保留） | 同文件 `campus_dscp_postrouting` |
| QUIC/HTTP3 逃逸 | 转发层 DROP UDP/443，强制 TCP TLS | 同文件 `campus_quic_block` |
| DNS 旁路 | LAN 全部 53 端口重定向到 dnsmasq（含硬编码 8.8.8.8 的设备） | `15-campus-dns-fix.nft` |
| DoT 逃逸 | TCP/UDP 853 DROP | `20-campus-egress-hygiene.nft` |
| 网络发现泄漏 | NetBIOS/SMB/SSDP/WS-Disc/mDNS/LLMNR 出方向 DROP | 同上 `campus_leak_block` |
| ICMP 时间戳 | type 13/14 DROP（防 OS + 开机时长泄漏） | 同上 |
| NTP 指纹 | LAN 123 端口重定向到路由器自身 ntpd | 同上 `campus_ntp_redirect` |
| DHCP 指纹 | WAN 伪装 `DESKTOP-CAMPUS`；LAN vendor-class 统一 | `98-campus-dhcp-fingerprint` |
| WAN MAC | 首刷随机本地管理 MAC（持久化）；LuCI 页面可查/改/克隆/轮换/复原 | `97-campus-wan-hygiene` + `95-campus-mac-luci` |
| IPv6 泄漏 | LAN 默认关 RA/DHCPv6 | `99-campus-fix-banner` |
| 栈指纹 | tcp_timestamps/window_scaling 保持开启、rp_filter 开 | `97-campus-wan-hygiene` |
| IP-MAC 绑定 / 客户端数 | NAT 天然只暴露路由器单 MAC + 单认证会话 | 无需配置 |
| UA/系统指纹 | 路由器层无法改写 HTTPS 内 UA；QUIC 已封后用终端浏览器扩展做 UA 一致化 | 终端侧 |

### 可选开关（默认关，按需开）

在 `/etc/nftables.d/20-campus-egress-hygiene.nft` 里取消注释，然后
`service firewall restart`：

- **IGMP 出方向 DROP**：多播成员报告暴露多接收者。不用校园 IPTV 才能开。
- **每主机并发连接数上限**（300，dynamic set）：对抗流数统计。取消注释
  `campus_flowtab4` set 和 `campus_flowcap` chain 两个块。

### LuCI 页面「Campus MAC」（Network 菜单）

- **查看**：显示 WAN 口实际生效的 MAC（实时读网卡）
- **手动设置**：填任意合法 MAC。典型用法是**克隆你电脑网卡的 MAC**——
  校园网把认证绑到电脑 MAC 时，克隆后路由器无缝顶替，无需重新注册
- **Rotate**：一键生成新随机 MAC（本地管理位自动处理），生成后填入框内，点 **Save & Apply** 持久化
- **Reset / 留空保存**：恢复出厂 WAN MAC
- 改完 `ifup wan` 或重启生效；**除克隆场景外，改 MAC 后要在校园网认证页
  重新登录**（认证会话绑定 MAC）
- 三种模式（custom / factory / 首刷随机）持久化，重启不丢

### 刻意不做的（及理由）

- **不封 DoH**：走 443/TCP 与正常流量无法区分，误伤太大；QUIC 已封，
  DoH-over-HTTP/3 天然不可用
- **IP-ID 不用固定值**：破坏分片重组且本身是异常特征，用 flow-hash
- **不做 LAN 侧 MAC 随机化**：NAT 已隐藏 LAN MAC，多此一举

## 使用方法

1. **构建**：本仓库已配好 Actions。进 **Actions → Build RM AC2100 OpenWrt
   firmware → Run workflow**，默认参数（24.10.2 + LuCI + v2.3.1）直接 Run，
   约 3-5 分钟出包。可调输入：
   - `openwrt_version`：OpenWrt 底包版本
   - `include_luci`：是否带 LuCI（false = 纯 CLI，省内存）
   - `fw_version`：版本戳（写进固件 + artifact 名
     `rm2100-firmware-v<版本>-openwrt-<OpenWrt 版本>`）

2. **下载校验**：从 run 页面下载 artifact，解压得到三个 .bin + `sha256sums`。
   本地 `sha256sum -c sha256sums` 全 OK 再刷。
   > RM AC2100 是 NAND 闪存，OpenWrt 官方**不产出 factory.bin**，
   > breed 刷机用 kernel1.bin + rootfs0.bin 两个文件分别刷。

3. **首次刷机**（stock MiWiFi 固件，经 breed）：
   1. 断电 → 针按住 reset → 插电约 5 秒松开 → 电脑接 LAN 口开
      `192.168.1.1` 进 breed（RM AC2100 出厂即带 breed，无需先刷）
   2. breed 里**先备份编程器固件**（含所有分区），存好
   3. 固件更新，分两步：
      - `*-squashfs-kernel1.bin` → 闪存布局选 **Kernel**
      - `*-squashfs-rootfs0.bin` → 闪存布局选 **RootFS**
      - 都刷完后断电重启
   4. 约 2 分钟后 LAN 口访问 `192.168.1.1` 进 LuCI

4. **升级**（已在 OpenWrt 上）：LuCI → System → Backup/Flash Firmware 上传
   `*-squashfs-sysupgrade.bin`。**任何 campus-fix 版本间升级都不要保留配置**
   （uci-defaults 的 DHCP/IPv6/MAC 逻辑需要重新应用）。

5. **上网**：LuCI → Network → Interfaces → wan。DHCP 认证门户保持 dhcp；
   宿舍 PPPoE 拨号就切 pppoe。网线插面板丝印 WAN 口
   （OpenWrt 24.10 DSA 映射：WAN 口设备名 `wan`，LAN1-3 为 `lan1`-`lan3`；基接口同为 `eth0`，`ip link` 可见 `eth0` 上的 VLAN 子接口）。

## 首次进系统检查清单

```
cat /etc/campus-fix-version        # 应显示 2.3.1
nft list chain inet fw4 campus_ttl_postrouting     # counter 在涨 = TTL 归一生效
nft list chain inet fw4 campus_quic_block          # drop 在涨 = 有客户端试图 QUIC
nft list chain inet fw4 campus_leak_block          # 发现协议封锁生效
cat /etc/campus-fix-wanmac         # 首刷生成的 WAN MAC（LuCI Campus MAC 页同款）
```

## 调整与维护

- **TTL 基准改 64**（校园网按 Linux/Mac/Android 指纹判定时）：LuCI → System → TTYD
  终端或 ssh，改 `/etc/nftables.d/10-campus-ttl-fix.nft` 里
  `campus_ttl_postrouting` 两处 `128` → `64`（`campus_ipid_postrouting` 的
  `ip ttl 64-128` 匹配域不用动），`service firewall restart`
- **改规则后重建固件**：改 `files/` 下对应文件，commit + push，重新 Run
  workflow（workflow 里 `PACKAGES` 追加了 `kmod-ipt-nat ip6tables-nft
  iptables-nft`，兼容 iptables 老脚本习惯）
- **某设备必须用指定 DNS**（如公司 VPN 客户端校验）：LuCI 防火墙给它加
  例外，或删 `/etc/nftables.d/15-campus-dns-fix.nft`
- **要连校园网 SMB 文件共享**：删 `20-campus-egress-hygiene.nft` 里
  `tcp dport 445` 那行再 restart

## 副作用（均为预期行为）

- LAN 设备 outbound traceroute 第 2 跳以后不可见（TTL 归一化）
- 依赖 QUIC 的应用（YouTube 部分流量、WhatsApp 通话）自动回退 TCP
- 硬编码公共 DNS 的设备被静默重定向到路由器
- LAN 设备 NTP 由路由器代答，时间来源统一
- 校园网内的 SMB/发现类广播出不去（如需访问校园共享见上节）

## 故障排查

| 症状 | 处理 |
|---|---|
| TTL 改过仍被踢 | v2.x 已覆盖 IP-ID/DSCP/QUIC/DNS/DHCP/MAC；再被踢说明检测在 TLS 指纹（JA3）或行为统计层，需终端侧配合 |
| 改 MAC 后无法上网 | 认证会话绑旧 MAC——认证页重新登录 |
| 某应用异常 | 先查 `nft list chain inet fw4 campus_leak_block` 的 drop 计数是否在涨，确认是否被卫生规则误伤 |
| 内存告急 | 128MB 上限：别装 docker/大插件；或构建时 `include_luci=false` |
| 刷砖 | breed 不死引导兜底：重进 breed 重刷即可，之前备份的编程器固件也能救回 |

## 固件文件清单

```
files/
├── etc/nftables.d/
│   ├── 10-campus-ttl-fix.nft        # TTL / IP-ID / DSCP / QUIC（核心）
│   ├── 15-campus-dns-fix.nft        # LAN DNS 强制重定向
│   └── 20-campus-egress-hygiene.nft # DoT/发现协议/ICMP-ts 封锁 + NTP 重定向 + 可选开关
└── etc/uci-defaults/
    ├── 95-campus-mac-luci           # LuCI「Campus MAC」页面
    ├── 96-campus-ntp-server         # 路由器自身 ntpd 开 LAN 监听
    ├── 97-campus-wan-hygiene        # WAN MAC 三模式 + TCP 栈参数
    ├── 98-campus-dhcp-fingerprint   # DHCP 指纹伪装
    └── 99-campus-fix-banner         # 版本戳 + IPv6 RA 关闭 + 登录横幅
```

## 版本历史

| 版本 | 内容 |
|---|---|
| v1.0.0 | TTL/hoplimit 归一化（fw4 drop-in） |
| v2.0.0 | + IP-ID flow-hash、DSCP 归一、QUIC 封锁、DNS 重定向、DHCP 指纹、LAN IPv6 关闭；版本戳进固件 |
| v2.1.0 | + DoT/发现协议/ICMP-ts 封锁、NTP 重定向、WAN MAC 随机化、栈参数；IGMP/流数上限可选开关 |
| v2.2.0 | + LuCI「Campus MAC」页面（查/设/克隆/轮换/复原），MAC 三模式持久化 |
| v2.3.0 | 修复：IP-ID 规则 `hash`→`jhash`（v2.0 起语法错误导致 fw4 整表加载失败、首刷断网）；MAC 随机化 `od`→`hexdump`（busybox 无 od，原 fallback 会让所有设备同 MAC）；Campus MAC 页面重写为 ucode 实现（24.10 luci-base 无 Lua 运行时，原 Lua CBI 页面静默失效）；NTP interface list→option；CI 增加 nft 语法校验步骤 |
| v2.3.1 | TTL/hoplimit 默认基准 64 → 128（Windows 指纹；校园认证通常面向 PC，128 亦是更保守的默认） |
