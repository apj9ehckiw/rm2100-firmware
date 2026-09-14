# RM2100 固件构建（GitHub Actions）

红米 RM AC2100（MediaTek MT7621A，128MB RAM / 16MB flash）专用 OpenWrt 固件，
内置**校园网多设备检测规避**套件，通过 GitHub Actions 云端构建，本机无需 Linux 环境。

当前固件版本：**v2.2.0**（`/etc/campus-fix-version`，Actions 里可用 `fw_version` 输入改）

## 使用方法

1. 在 GitHub 新建仓库，把本目录全部内容推上去（公开仓库 Actions 免费额度足够）：
   ```
   cd rm2100-firmware
   git init && git add -A && git commit -m "rm2100 campus-fix firmware"
   git remote add origin https://github.com/<你的用户名>/rm2100-firmware.git
   git push -u origin main
   ```
   （GitHub 推送走代理：`git config --global http.https://github.com.proxy socks5h://127.0.0.1:7897`）

2. 网页上进入 **Actions → Build RM AC2100 OpenWrt firmware → Run workflow**，
   默认参数（24.10.2 + LuCI + fw_version 2.0.0）直接点 Run。约 3-5 分钟出包。
   升级版本时改 `fw_version` 输入（会写进固件 `/etc/campus-fix-version` 和
   artifact 名字：`rm2100-firmware-v<版本>-openwrt-<OpenWrt 版本>`）。
   v1→v2 或 v2→v2.1 升级都**不要**保留配置。

3. 在该次运行页面下载 artifact（如 `rm2100-firmware-v2.0.0-openwrt-24.10.2`），解压得到：
   - `openwrt-*-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-kernel1.bin`
   - `openwrt-*-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-rootfs0.bin`
   - `openwrt-*-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-sysupgrade.bin`
   - `sha256sums`

   > RM AC2100 是 NAND 闪存设备，OpenWrt 官方**不产出 factory.bin**，
   > breed 刷机用 kernel1.bin（内核）+ rootfs0.bin（根文件系统）两个文件分别刷。

## 校验

对比 artifact 内 `sha256sums` 与本地 `sha256sum` 输出一致再刷机。

## 固件内置的规避规则（v2.0.0）

| 检测手段 | 对策 | 位置 |
|---|---|---|
| TTL 检测 | WAN 出方向 IPv4 TTL / IPv6 hoplimit 强制 64 | `10-campus-ttl-fix.nft` `campus_ttl_postrouting` |
| IP-ID 熵检测 | 每 flow 稳定 IP-ID（flow tuple hash），消除多 OS 混合指纹 | `10-campus-ttl-fix.nft` `campus_ipid_postrouting` |
| DSCP/QoS 相关性 | 出方向 DSCP 全部归一 CS0，ECN 保留 | `10-campus-ttl-fix.nft` `campus_dscp_postrouting` |
| QUIC/HTTP3 逃逸 | 转发层 DROP UDP/443，强制 TCP TLS（UA 类工具才能生效） | `10-campus-ttl-fix.nft` `campus_quic_block` |
| DNS 旁路检测 | LAN 全部 53 端口重定向到路由器 dnsmasq（含硬编码 8.8.8.8 的设备） | `15-campus-dns-fix.nft` `campus_dns_redirect` |
| DHCP 指纹 | WAN 客户端伪装 DESKTOP-CAMPUS（Windows 型）；LAN 侧 vendor-class 统一 | `98-campus-dhcp-fingerprint` |
| IPv6 指纹泄漏 | LAN 默认关闭 RA/DHCPv6（无 v6 就无 hop-limit / 前缀指纹路径） | `99-campus-fix-banner` uci-defaults |
| IP-MAC 绑定 | NAT 天然只暴露路由器 WAN 口 MAC | 无需配置 |
| 在线客户端数 | 只有路由器本身参与认证 | 无需配置 |
| UA/系统指纹 | QUIC 已封（UDP/443 DROP），TCP TLS 下可用终端浏览器扩展做 UA 一致化；路由器层无法强制改写 HTTPS 内的 UA | 终端侧 |

### v2.1.0 新增

| 检测手段 | 对策 | 位置 |
|---|---|---|
| DoT 逃逸（853） | DROP——否则加密 DNS 绕过 53 端口重定向 | `20-campus-egress-hygiene.nft` `campus_leak_block` |
| 网络发现泄漏 | NetBIOS(137-139)/SMB(445)/SSDP(1900)/WS-Disc(3702)/mDNS(5353)/LLMNR(5355) 出方向 DROP——多设备广播是字面意义上的"自白"；桥接 WAN 模式下也安全 | 同上 |
| ICMP 时间戳 | type 13/14 DROP——Windows 默认应答，泄漏 OS + 开机时长 | 同上 |
| NTP 指纹 | LAN 全部 123 重定向到路由器自身 ntpd（`96-campus-ntp-server`），消除每设备 NTP 指纹 | `campus_ntp_redirect` |
| WAN MAC OUI | 首次开机生成持久化的本地管理 MAC，去掉小米 OUI 与"一台 Windows 主机"人设的矛盾 | `97-campus-wan-hygiene` |
| 栈指纹 | tcp_timestamps/window_scaling 保持开启（关了反而是新异常）、rp_filter 开 | 同上 |

### v2.2.0 新增

**LuCI 页面「Campus MAC」**（Network 菜单下）：自定义 WAN MAC 全功能管理——
- **查看**当前 WAN 口实际生效的 MAC（不是只显示配置值）
- **手动设置**：填入任意合法 MAC（比如克隆你电脑网卡的 MAC——校园网把认证绑定到
  你电脑 MAC 时，克隆它路由器就无缝顶替，无需重新注册）
- **Rotate**：一键换新随机 MAC（本地管理位自动处理）
- **Reset**：恢复出厂 WAN MAC
- 留空保存 = 恢复出厂；改完 `ifup wan` 或重启生效；**改 MAC 后需在校园网认证页
  重新登录**（认证会话绑定 MAC）
- 页面写入会持久化，重启不丢，也不会被首刷随机逻辑覆盖

### 默认注释掉、需要时再开（在 `20-campus-egress-hygiene.nft` 里取消注释）：
- **IGMP 出方向 DROP**：多播成员关系报告暴露多接收者。只在不用校园 IPTV 时开。
- **每主机并发连接数上限**（默认 300，dynamic set 实现）：对抗流数统计。
  开启方式：取消注释 `campus_flowtab4` set 和 `campus_flowcap` chain 两个块。

**已启用/未启用的取舍**：
- IP-ID 用 flow-hash 而非固定值：固定值会破坏分片重组且本身是异常特征。
- 不封 DoH：DoH 走 443/TCP 与正常流量无法可靠区分，误伤太大；QUIC 已封，
  DoH-over-HTTP/3 不可用。
- 不做每客户端 MAC 随机化：NAT 已经不暴露 LAN MAC，多此一举。

**TTL 目标值**：默认 64（Linux/Mac/Android 指纹）。如果校园网期望的是 Windows
主机（128），登录 LuCI → System → TTYD 终端（或 ssh）修改
`/etc/nftables.d/10-campus-ttl-fix.nft` 里 `campus_ttl_postrouting` 两处
`64` 为 `128`（注意 `campus_ipid_postrouting` 里的 `ip ttl 64-128` 匹配域
不用动），执行 `service firewall restart`。

**验证规则生效**（ssh 后）：
```
nft list chain inet fw4 campus_ttl_postrouting    # counter 应该在涨
nft list chain inet fw4 campus_quic_block         # drop 计数在涨 = 有客户端试图 QUIC
```

**副作用提醒（v2 新增）**：
- 局域网内依赖 QUIC 的应用（YouTube 部分流量、WhatsApp 通话）自动回退 TCP，正常。
- 硬编码 DNS 的设备会被静默重定向到路由器——如果某设备必须用特定 DNS（如
  公司 VPN 客户端校验），在 LuCI 防火墙里为它加例外，或删除 15 号文件。

**副作用**：LAN 侧设备 outbound traceroute 到第 2 跳以后不可见（TTL 被归一化的
正常结果）。

## 刷机流程（RM AC2100 专用）

RM AC2100 官方固件没有直接刷 OpenWrt 的入口，需要先刷 breed（不死引导）：

1. **进 breed**：路由器断电，用针按住 reset 不放，插电约 5 秒后松开，
   电脑接 LAN 口，浏览器打开 `192.168.1.1` 进入 breed Web 界面。
   （RM AC2100 出厂即带 breed 不死引导，无需先刷。）
2. **备份**：breed 界面里先备份编程器固件（含所有分区），存好。
3. **刷 OpenWrt**（breed → 固件更新，分两步）：
   - **内核版**：选 `*-squashfs-kernel1.bin`，闪存布局选 **Kernel**，
     点上传刷入；
   - **固件版**：选 `*-squashfs-rootfs0.bin`，闪存布局选 **RootFS**，
     点上传刷入；
   - 两个都刷完后，断电重启。
4. 等约 2 分钟重启完成，LAN 口后访问 `192.168.1.1` 进入 LuCI。

> 如果路由器已经刷过 OpenWrt/Padavan，直接 LuCI → System →
> Backup/Flash Firmware 上传 `*-squashfs-sysupgrade.bin` 升级即可。
> 跨大版本升级**不要**勾选保留配置。

## WAN 口接线说明

OpenWrt 对 RM AC2100 的默认端口映射：面板丝印 WAN 口 = `eth0.2`（wan），
LAN1-LAN3 = `eth0.1`（br-lan）。光猫/宿舍网口网线插 WAN 口即可。

## 日后修改规则 / 重新构建

改 `files/etc/nftables.d/10-campus-ttl-fix.nft` 或 workflow 里的
`PACKAGES`，提交 push 后重新 Run workflow 即可。

## 已知事项 / 故障排查

- **校园网检测 ICMP TTL**（对 ping 包也做检测）：本规则 `postrouting` 同样覆盖
  ICMP，无需额外处理。
- **如果改 TTL 后仍被踢**：v2 已覆盖 IP-ID 熵 / DSCP / QUIC / DNS / DHCP 指纹；
  仍被踢说明检测在 TLS 指纹（JA3）或行为统计层面，需要终端侧配合，反馈后再议。
- **v1 升级 v2**：直接 sysupgrade 刷 sysupgrade.bin，**不要**保留配置（uci-defaults
  里的 DHCP/IPv6 设置需要重新应用）。
- **128MB 内存提醒**：AC2100 只有 128MB RAM，LuCI + 无线全开时余量不多。
  不要装 docker / 大型插件，qm-buff 之类坑内存的包别上。
- workflow 里 `PACKAGES` 默认追加 `kmod-ipt-nat ip6tables-nft iptables-nft`
  是为了兼容习惯用 `iptables -t mangle` 的老脚本；nft 路径用上面文件即可。
