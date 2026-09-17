# RM2100 campus-fix 固件

红米 RM AC2100（MediaTek MT7621A，128MB RAM / 16MB flash）专用 OpenWrt 固件，
内置**校园网多设备检测规避**套件，通过 GitHub Actions 云端构建，本机无需 Linux 环境。

**当前固件版本：v2.6.6**（刷入后 `cat /etc/campus-fix-version` 查询）

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
| WAN MAC | 默认出厂 MAC（不随机化）；LuCI 页面可查/改/克隆/轮换/复原（存 uci） | `95-campus-mac-luci` |
| IPv6 泄漏 | LAN 默认关 RA/DHCPv6 | `99-campus-fix-banner` |
| 栈指纹 | tcp_timestamps/window_scaling 保持开启、rp_filter 开 | `97-campus-wan-hygiene` |
| IP-MAC 绑定 / 客户端数 | NAT 天然只暴露路由器单 MAC + 单认证会话 | 无需配置 |
| UA/系统指纹 | 路由器层无法改写 HTTPS 内 UA；QUIC 已封后用终端浏览器扩展做 UA 一致化 | 终端侧 |
| Portal 认证 | 校园网 Portal 自动登录/掉线重连（quickauth 协议，凭据存路由器） | LuCI「校园网认证」页面 |

### 可选开关（默认关，按需开）

在 `/etc/nftables.d/20-campus-egress-hygiene.nft` 里取消注释，然后
`service firewall restart`：

- **IGMP 出方向 DROP**：多播成员报告暴露多接收者。不用校园 IPTV 才能开。
- **每主机并发连接数上限**（300，dynamic set）：对抗流数统计。取消注释
  `campus_flowtab4` set 和 `campus_flowcap` chain 两个块。

### LuCI 页面「校园网 MAC」（网络菜单）

- **查看**：显示 WAN 口实际生效的 MAC（实时读网卡，页面为简体中文）
- **手动设置**：填任意合法 MAC。典型用法是**克隆你电脑网卡的 MAC**——
  校园网把认证绑到电脑 MAC 时，克隆后路由器无缝顶替，无需重新注册
- **Rotate**：一键生成新随机 MAC（本地管理位自动处理），生成后填入框内，点 **Save & Apply** 持久化
- **Reset / 留空保存**：恢复出厂 WAN MAC
- 改完 `ifup wan` 或重启生效；**除克隆场景外，改 MAC 后要在校园网认证页
  重新登录**（认证会话绑定 MAC）
- 自定义 MAC 直接存 uci（`network.wan.macaddr`），重启不丢；**默认即出厂 MAC**（v2.6 起不再首刷随机）

### LuCI 主题与语言

- **主题**：Argon（v2.4.7，第三方 [jerrykuku/luci-theme-argon](https://github.com/jerrykuku/luci-theme-argon)，
  构建时从 GitHub Releases 拉取 `_all` 包——官方 24.10 feed 没有收录此主题）
- **语言**：默认简体中文（`luci.main.lang='zh_cn'`，浏览器语言优先级失效；
  想跟随浏览器就改回 `auto`）
- `include_luci=false` 构建时不含主题与语言包（纯 CLI）

### 校园网认证（LuCI「校园网认证」页面）

基于认证流程抓包逆向实现的 Portal 自动认证：

- **自动登录**：填学号密码并启用后，后台守护进程每 90 秒（可调）检测一次；
  被踢下线后自动重新认证，无需手动开认证页
- **检测机制**：未认证时任意 HTTP 请求会被劫持到 10.0.0.1——探测不到劫持即视为在线，
  不会反复发认证请求（避免行为异常）
- **手动操作**：页面提供「登录/下线」按钮即时操作，实时显示认证状态
- **凭据安全**：学号密码存在 `/etc/config/campusauth`（权限 0600，仅 root 可读）
- **认证协议**：GET `quickauth.do`（明文 HTTP，该校部署未启用 RSA 加密）；
  code=0 成功 / 201 已在线 / 236-238 需设备绑定（需手动处理）/ -1 失败重试
- **注意**：密码经明文 HTTP 传输给认证服务器——这是该校 Portal 本身的协议设计，
  与本固件无关；有线/无线校园网内嗅探者理论上可见

### 刻意不做的（及理由）

- **不封 DoH**：走 443/TCP 与正常流量无法区分，误伤太大；QUIC 已封，
  DoH-over-HTTP/3 天然不可用
- **IP-ID 不用固定值**：破坏分片重组且本身是异常特征，用 flow-hash
- **不做 LAN 侧 MAC 随机化**：NAT 已隐藏 LAN MAC，多此一举

## 使用方法

1. **构建**：本仓库已配好 Actions。进 **Actions → Build RM AC2100 OpenWrt
   firmware → Run workflow**，默认参数（24.10.2 + LuCI + Argon 主题 + 简体中文 + v2.6.6）直接 Run，
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
cat /etc/campus-fix-version        # 应显示 2.6.6
nft list chain inet fw4 campus_ttl_postrouting     # counter 在涨 = TTL 归一生效
nft list chain inet fw4 campus_quic_block          # drop 在涨 = 有客户端试图 QUIC
nft list chain inet fw4 campus_leak_block          # 发现协议封锁生效
uci -q get network.wan.macaddr     # 自定义 WAN MAC（若通过 LuCI 设置过；出厂 MAC 时为空）
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
    ├── 97-campus-wan-hygiene        # TCP 栈参数（WAN MAC 走 uci，无需重放）
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
| v2.4.0 | + LuCI Argon 主题（第三方包，构建时自动拉取）+ 界面默认简体中文 |
| v2.4.1 | 「校园网 MAC」页面全部界面文本改为简体中文（菜单/表单/按钮/通知） |
| v2.5.0 | + 校园网 Portal 自动认证：quickauth 协议自动登录/掉线重连守护进程 + LuCI「校园网认证」页面（凭据/间隔/Portal 地址可配，手动登录/下线） |
| v2.6.0 | WAN MAC 默认改回出厂（取消首刷随机化）；修复「校园网 MAC」页面显示「未知」——rpcd 只在启动时扫描 ucode 插件，首刷脚本落盘后未重启 rpcd 导致 ubus 调用失败；livemac 增加 uci 回退与 l3_device 解析 |
| v2.6.1 | 修复两个 rpcd ucode 插件加载失败（这才是「未知/Object not found」的真正根因）：95 的 `import { pclose }`——fs 模块并无此导出（close 是 popen 句柄方法）；93 的 `new RegExp(...)`——ucode 语言没有 `new` 关键字，动态正则须用 `regexp()` 内置函数。两处均对齐官方 LuCI rpcd 插件写法 |
| v2.6.2 | 真正根因修复：rpcd ucode 插件的返回值结构错误。rpcd 要求 `return { <对象名>: { <方法名>: { call: fn } } }`（顶层 key 即 ubus 对象名，官方 luci 插件即 `return { luci: methods }`），而 93/95 写成了 `return { status: {call:fn}, ... }`——rpcd 把方法名当对象名校验，报 "Invalid method definition: expected dictionary, got function" 后跳过注册，ubus 上永远没有 campusauth/campusmac 对象，于是 LuCI 报 Object not found / MAC 显示未知（v2.6.1 修的两处确实是 bug 但不是这个症状的根因）。附带修复：rotate 中 hex2dec→hexdec（libucode 内建名）；rpcd restart 改为仅在 rpcd 已运行时执行（首刷时 rpcd 尚未启动，S12 自然加载插件） |
| v2.6.3 | 修两个状态显示问题。①「校园网认证」状态恒为 unknown：服务从未被 enable/启动（uci-defaults 只写 init 脚本不 enable），且 procd 触发器只在服务首次 start 后才注册——首刷后用户勾选「启用自动认证」保存也不会拉起 daemon。修复：首刷 enable+start 一次（注册 procd 条目与 reload 触发器）+ 写 ucitrack campusauth.json（LuCI 保存即 reload）+ daemon 每轮重读 uci（enabled/凭据/间隔，reload 链全失效也能自愈）+ status() 增加运行中检测（procd pidfile + kill -0，注意 sh 脚本 comm 是 sh 故不能用 pgrep -x）②「校园网 MAC」WAN 口实际 MAC 恒为未知：rpc.js 的 expect 类型校验陷阱——`expect { 'mac': null }` 会在返回值类型（String）与默认值类型（Null）不一致时把真实 MAC 覆盖成 null！改为 `expect { 'mac': '' }`。附：daemon enabled=0/无凭据时写入明确状态文案而非静默 |
| v2.6.4 | 修复「已在线免认证被误报 probe-failed」：MAC 无感知认证场景（上次认证过+同 MAC），AC 不再劫持 10.0.0.1，daemon 探测拿不到 portal.do 跳转，而 AUTH_OK 是内存态（重启归零）→ 旧逻辑直接报 probe-failed。修复：无劫持跳转时先 ping 公网 DNS（223.5.5.5/119.29.29.29，IP 直连不受 DNS 劫持影响）——通则判定 online(mac-auth/免认证)；不通再按「网关是否应答过 HTTP」细分 offline/probe-failed 文案。真正掉线时 AC 会恢复劫持，主认证路径不受影响 |
| v2.6.5 | 清理 v2.6.0 MAC 三模式残留死代码：97-campus-wan-hygiene 的 /etc/campus-fix-macmode + /etc/campus-fix-wanmac 开机重放逻辑自 v2.6.0 起无任何代码写入这两个文件，分支永不可达——custom MAC 实际经 LuCI 直存 uci（network.wan.macaddr），netifd 每次 ifup 自动重放。删除不可达分支并同步更正 95 注释与 README（首检清单改 `uci -q get network.wan.macaddr`）。无行为变化，纯清理 |
| v2.6.6 | 「校园网认证」页学号输入框增加掩码显示（∗ 显隐切换按钮），与密码框交互一致。仅 UI 层，uci 明文存储与 daemon/rpcd 读取路径不变 |
