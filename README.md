# RM2100 campus-fix 固件

红米 RM AC2100（MediaTek MT7621A，128MB RAM / 16MB flash）专用 OpenWrt 固件，
内置**校园网多设备检测规避**套件，通过 GitHub Actions 云端构建，本机无需 Linux 环境。

**当前固件版本：v2.8.1**（刷入后 `cat /etc/campus-fix-version` 查询；LuCI 页脚也显示 `campus-fix vX.Y.Z`）

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
| MSS 指纹混合 | WAN 出向 SYN 的 TCP MSS 统一 clamp 到路径 MTU（灰度回归，fw4guard 兜底） | `25-campus-mss.nft` `campus_mss_clamp` |
| 代理行为封禁识别 | quickauth 应答含「禁用/禁止/代理行为/封禁」即解析分钟数，banned 状态静默到期（重复尝试会加重标记） | `93-campus-auth` |
| 探测行为签名 | 认证守护进程间隔随机抖动（±20%）；非校园网环境指数退避并停止外部探测 | `93-campus-auth` |
| 上游 DNS 瘫痪韧性 | dnsmasq 并发查询上限 150→500、负缓存 10s；daemon 状态区分停机/非停机时段断网 | `98-campus-dhcp-fingerprint` `93-campus-auth` |
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
- **检测机制**：未认证时 AC 劫持任意 80 端口请求（探测点 3.3.3.3/10.0.0.1，
  3.3.3.3 为校方公告的 portal 入口）；在线判定以「ping qq.com 域名解析通」
  为第一信号（未认证与停机时 DNS 均死、但 ping IP 均通——ICMP 对 IP 永远
  不能当在线依据），HTTP generate_204 为兜底
- **三态识别**：同一探测点 3.3.3.3 的应答即可区分三种状态——未认证=跳
  portal.do 登录页 / 已认证=跳 portalLogout.do（跳转含 logout 即排除）/
  停机=应答「该时间段不在可用区间」类拒绝文案（关键词：不在可用/可用区间/
  时间段/暂停/停机/维护），状态栏显示 maintenance 并静默等待到点恢复
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
   firmware → Run workflow**，默认参数（24.10.2 + LuCI + Argon 主题 + 简体中文 + v2.8.1）直接 Run，
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
cat /etc/campus-fix-version        # 应显示 2.8.1
nft list chain inet fw4 campus_ttl_postrouting     # counter 在涨 = TTL 归一生效
nft list chain inet fw4 campus_quic_block          # drop 在涨 = 有客户端试图 QUIC
nft list chain inet fw4 campus_leak_block          # 发现协议封锁生效
logread -e campus-fw4guard                         # 应有 dry-run OK（无输出=无 drop-in 或未跑）
nft list chain inet fw4 campus_mss_clamp           # counter 在涨 = MSS 归一生效
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
| TTL 改过仍被踢 | v2.7 已覆盖 TTL/IP-ID/DSCP/QUIC/DNS/DHCP/MAC/MSS/流数/速率；再被踢说明检测在 TLS 指纹（JA3）或 UA 层，需终端侧配合（浏览器扩展统一 UA） |
| 日志刷 "Maximum number of concurrent DNS queries reached" | 上游 DNS 瘫痪时 LAN 客户端重试堆积。v2.7.2 已调 dnsforwardmax=500 + 负缓存 10s 缓解；若仍频繁出现，检查上游 DNS 是否长期不可用（换 223.5.5.5 等公共 DNS 做转发）
| 手动下线报「下线失败（code=1）」 | v2.7.4 已修：下线请求 portaltype 对齐官方 logout 页的空串（原硬编码 0 被 AC 拒绝）；LuCI 通知现在同时显示服务端 message |
| 勾选自动认证后不认证、日志报 HTTP dead | v2.7.0-2.7.2 的致命 bug：uclient-fetch **没有** --header 选项，v2.7.0 加上的 --header 让所有请求静默失败（usage 错误被 2>/dev/null 吞掉）→ 探测不到劫持页 → 永远不会走认证路径。v2.7.3 已移除全部 --header 用法 |
| daemon 报 "HTTP dead, ICMP alive" 但不是停机时段 | v2.7.2 起状态与日志区分「停机时段」与「非停机时段（疑似上游 DNS 故障）」；同时修复移动 WiFi 上级路由占用 10.0.0.1 导致退避永不生效的漏洞（现仅劫持跳转/真实可达才复位退避） |
| 触发「代理行为」封禁 | v2.7.1 已含守护进程抖动退避 + 请求头补齐（MSS/速率规则因 v2.7.0 事故撤回）；若再次触发，先确认终端是否开着代理/VPN 客户端 |
| 刷后 LAN 不通 / 拿不到 IP | `logread -e campus-fw4guard` —— v2.7.1 起规则集加载失败会自动隔离 `/etc/nftables.d/` 下全部 drop-in 并按原厂防火墙起网（日志可见），LAN 永不再因规则挂掉 |
| 改 MAC 后无法上网 | 认证会话绑旧 MAC——认证页重新登录 |
| 「校园网 MAC」页点「生成」报 MAC 生成失败（Network 面板看 rpcd 应答正常） | v2.8.1 已修：前端 rpc.declare 的 `expect:{'mac':''}` 把应答解包成裸字符串，`ret.mac` 为 undefined 走了失败分支（livemac 同因致「实际 MAC」恒显未知）。改 `expect:{}` 取完整对象 |
| 某应用异常 | 先查 `nft list chain inet fw4 campus_leak_block` 的 drop 计数是否在涨，确认是否被卫生规则误伤 |
| 内存告急 | 128MB 上限：别装 docker/大插件；或构建时 `include_luci=false` |
| 刷砖 | breed 不死引导兜底：重进 breed 重刷即可，之前备份的编程器固件也能救回 |

## 固件文件清单

```
files/
├── etc/nftables.d/
│   ├── 10-campus-ttl-fix.nft        # TTL / IP-ID / DSCP / QUIC（核心）
│   ├── 15-campus-dns-fix.nft        # LAN DNS 强制重定向
│   ├── 20-campus-egress-hygiene.nft # DoT/发现协议/ICMP-ts 封锁 + NTP 重定向 + 可选开关
│   └── 25-campus-mss.nft           # MSS clamp（v2.8.0 灰度回归，fw4guard 兜底）
└── etc/uci-defaults/
    ├── 89-campus-fw4guard           # fw4 规则集自检：加载失败自动隔离 drop-in（保 LAN 永不死）
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
| v2.6.7 | 在线检测从 ICMP 换为 HTTP generate_204 双探测点（connect.rom.miui.com / 204.ustclug.org）：该校工作日 23:30 强制断网时 HTTP+DNS 全断、仅 ICMP 放行（ping 223.5.5.5 通但 ping qq.com 不通），纯 ping 检测会把停机误判为在线。新方案：真在线=204 空正文；未认证=劫持页含 portal.do；停机=DNS/连接失败。ICMP 降级为纯诊断信号（区分「停机断网」与「完全断网」文案）；check_online 每轮执行（原来 AUTH_OK=1 时跳过），停机即时感知、AUTH_OK 归零、恢复后 AC 重新劫持即自动重认证；新增 portal-transition 状态（探测到劫持页但 10.0.0.1 未恢复劫持跳转的 AC 过渡态）；停机期间启动路由器不再误报 probe-failed/offline |
| v2.6.8 | 自动认证调度：新增运行时间区间（active_start/active_end，HH:MM，支持跨午夜如 22:00-06:00，留空=全天）与运行星期开关（day_1~day_6/day_0 复选框，默认每天）。两层闸门独立组合：时段外/未勾选当天暂停一切探测与登录（状态显示 paused 及原因）；配置畸形 fail-open（视为全天/每天，手误不至于让认证哑火）；跨午夜窗口 00:00 后按新一天判断。LuCI 无 'time' datatype（未注册类型会让 Validator 抛错毁表单），HH:MM 校验用自定义 validate；shell test 无 >= 操作符用 NOT(小于) 组合（20+11 单测用例全过） |
| v2.6.9 | LuCI 界面显示固件版本号：99-campus-fix-banner 首刷时向主题 footer 模板（argon 的 footer/footer_login、bootstrap 的 footer）注入「campus-fix vX.Y.Z」，登录页与所有管理页页脚可见，不再需要 ssh 查 `/etc/campus-fix-version`。注入带 grep 幂等保护（重复运行不叠加）；sed BRE 陷阱记录：`\(...\)` 是分组、裸 `)` 是字面括号，bootstrap 的 `(distrevision }})</a>` 匹配不能给右括号加转义 |
| v2.6.10 | 修复「校园网认证」页保存报错：运行开始/结束时间填任何合法 HH:MM（如 07:00）都被拒——自定义 validate 签名写错。LuCI 框架经 `getValidator()` 做 `L.bind(this.validate, this, section_id)`，`validation.js` 再以 `vfunc(value)` 调用，实际展开为 `f(section_id, value)`——单参数 `f(value)` 接到的是 section id（'login'）而非输入值，正则永远不匹配。改为官方签名 `f(section_id, value)`（对齐 firewall/ipsets 等官方视图写法）。13 个边界用例（合法 HH:MM×4、空/null、`7:00`/`24:00`/`07:0`/`07:60`/`07:00:00` 等非法值×7）模拟完整绑定链全部通过 |
| v2.7.0 | 反检测升级（响应「发现您当前网络环境存在代理行为,禁用认证30分钟」触发）：①新增 `25-campus-connlimit.nft`——WAN 出向 SYN 的 TCP MSS 统一 clamp 到路径 MTU（消除 Windows 1460 / iOS 1440 / Android 1400-1460 的多设备混合指纹）、每 LAN 主机 SYN 速率限制（meter limit 40/s 突发 100，消除 N 设备聚合突发）、持续新建连接速率上限 600/分钟（meter 形态；ct-count-in-set 在部分环境不可用，meter 为等价可移植写法），替代旧可选块，默认启用②守护进程行为人性化：探测间隔 ±20% 随机抖动（消除固定 90s 秒表签名；busybox 无 $RANDOM，用 PID×7+秒数×13 混合散布）；非校园网环境（网关静默 3 轮起）指数退避至 10 倍间隔并完全停止外部 generate_204 探测——路由器挂在移动 WiFi 等外部网络时不再周期性戳探测点（正是被判定「代理行为」的流量形态）；检测到校园网关应答立即复位③uclient-fetch 请求头补齐 Accept/Accept-Language（对齐 HAR 实测浏览器头集，消除「Chrome UA + 极简头」的脚本签名），daemon 与 rpcd ucode 插件三处 fetch 全部生效 |
| v2.7.1 | 事故修复：v2.7.0 新增的 `25-campus-connlimit.nft`（MSS clamp/SYN 速率/新流速率三链）导致部分设备首刷后 LAN 完全不通（DHCP 无应答、169.254、ping 不通，breed 重刷无效）——fw4 对 nftables.d drop-in 的 include 是原子加载，规则集在目标内核上失败会让整个 fw4 表起不来，且故障模式超出预期波及了网络面。处置：①整文件回滚（恢复 v2.6.10 已验证规则集）②新增 `89-campus-fw4guard`：S18（先于 fw4 的 S19）启动前用 `fw4 print \| nft -c` 干跑校验完整规则集，失败则把 `/etc/nftables.d/*.nft` 全部隔离到 `/etc/nftables.d.disabled/` 再让 fw4 按原厂配置起网——今后任何规则问题最多损失反检测特性，LAN 永不死；daemon 侧 v2.7.0 的抖动/退避/请求头改动保留（不碰网络面） |
| v2.7.2 | 三项修复：①页脚 campus-fix 版本号着色（#5e72e4 蓝色加粗 span，与主题链接灰区分；sed 分隔符因颜色值含 # 改用 \|）②自动认证误判修复——18:19 日志复盘：dnsmasq 报 concurrent DNS queries 满（max:150）时 uclient-fetch 域名解析排队超时 → check_online 误报「HTTP dead, ICMP alive（停机）」，且周五非停机时段文案误导；修复：dnsmasq dnsforwardmax 500 + negcachettl 10s（上游 DNS 瘫痪时重试退避）；daemon 状态/日志区分停机（23:00-06:59 粗判）与非停机时段（明确提示疑似上游 DNS 故障且持续探测）；新增 tcp_ok()（nc -z / uclient-fetch 退出码映射）作无 DNS 的 TCP 直连探测；关键漏洞：10.0.0.1 有应答即复位 OFFCAMPUS_STRIKES——移动 WiFi 上级路由常占用 10.0.0.1 管理地址，导致退避永不生效、daemon 永远全速探测外网；现在仅「劫持跳转」或「公网 TCP 真实可达」才复位退避 ③页脚注入幂等测试改用临时目录端到端验证（注入产物/二次运行不叠加均过） |
| v2.7.3 | 致命 bug 修复：**uclient-fetch 没有 --header 选项**。v2.7.0 为「请求头一致性」给全部 4 处 uclient-fetch 调用加了 --header（daemon fetch/check_online + rpcd fetch/logout），未知长选项使 uclient-fetch 打 usage 并非 0 退出，而 2>/dev/null 把报错吞掉——于是：探测不到 10.0.0.1 劫持跳转（REDIRECT 恒空）→ 永远不走认证路径；check_online 恒失败 → 日志误报「HTTP dead, ICMP alive（停机?）」；LuCI「立即认证」也报「无法获取认证参数」。用户 18:19 日志的真实根因即此（非 DNS 故障——dnsmasq 告警是独立的上游问题，已由 v2.7.2 的 dnsforwardmax=500 缓解）。v2.7.3 移除全部 --header 用法恢复 UA-only 请求；教训入册：uclient-fetch ≠ GNU wget，选项集以 uclient-fetch.c 的 long_opts 为准 |
| v2.7.4 | 用户实测反馈驱动的三处修复：①劫持探测点改为 3.3.3.3 优先（校方公告的 portal 入口；未认证时 DNS 死→generate_204 域名解析失败→check_online 恒败，且 10.0.0.1 不再保证被劫持，daemon 拿不到跳转就永远进不了认证路径——探测序列改为 3.3.3.3→10.0.0.1，daemon 与 rpcd 手动认证两处同步）②在线判定第一信号改为 ping qq.com（域名解析通=DNS+ICMP 全通=真在线；用户实测未认证时 ping 223.5.5.5 也通——ICMP 对 IP 在未认证/停机两种状态下都放行，绝不能当在线依据；generate_204 降为兜底，保留 HTTP 层信号）③手动下线 code=1 修复：对照 HAR 与 portalUtil.js，官方下线请求 portaltype 是空串（getParam 取不到 logout.html URL 里不存在的参数），v2.7.3 硬编码 '0' 被 AC 拒绝；改为空串并让 LuCI 失败通知附带服务端 message |
| v2.7.5 | 用户实测补充：**认证后访问 3.3.3.3 也会跳转**（到 portalLogout.do「认证成功」页）——v2.7.4 的劫持探测会把该跳转当成「需要认证」，导致已在线状态每 90s 发一次 quickauth（201 already-online 循环），正是要避免的行为异常。两层修复：①probe_params 提取跳转后排除 URL 含 logout 的（portalLogout.do/logout.html 均命中，大小写不敏感；未认证的 portal.do 登录跳转不含该词不受影响）——daemon 与 rpcd 手动认证两处同步②拿到登录跳转后先 check_online（ping qq.com 优先）：外网可达则直接判定已在线、跳过认证请求，杜绝任何边缘状态下的重复认证循环 |
| v2.7.6 | 用户实测补全三态矩阵：**停机时 3.3.3.3 也会应答**——返回「该时间段不在可用区间」类拒绝文案（非劫持跳转）。v2.7.5 会把这种情况误报为 probe-failed（网关应答但无劫持跳转）。修复：probe_params 捕获 AC 拒绝页关键词（不在可用/可用区间/时间段/暂停/停机/维护，UTF-8 字节级 grep）到 PROBE_NOTE；主循环无劫持分支优先识别为 maintenance 状态（校园网在但夜间关闭，静默等待到点自动恢复认证）而非 probe-failed；off-campus 计分同步——命中拒绝文案=确凿在校园网（除校园网外无人会应答这种文本），退避计数复位永不误退避 |
| v2.8.0 | 三项功能：①「校园网 MAC」页 MAC 生成失败修复——rotate 的 popen 未做 null 防护（popen 失败即整个 rpcd 方法抛异常→LuCI 永远显示「MAC 生成失败」），且 hexdump -e 格式在部分环境产出为空；改为 /proc/sys/kernel/random/uuid 为主随机源（procfs 纯读取零依赖，去 - 后取 12 hex），hexdump 兜底，popen 全防护②MSS clamp 灰度回归（`25-campus-mss.nft`，单文件单链）——v2.7.0 三条规则齐上导致 LAN 全死后回滚，现按「一次一条+守卫兜底」策略重启：MSS clamp 与 fw4 官方 mtu_fix 输出同款内核表达式，fw4guard（S18）boot 干跑失败自动隔离 drop-in，最坏情况=该特性静默失效而非断网③代理行为封禁识别——quickauth 应答 message 命中「禁用/禁止/代理行为/封禁」关键词即解析「N分钟」（无数字默认 30），进入 banned 状态：显示到期时刻、静默等待（封禁期间同 MAC 重复认证会加重标记）、每 5 分钟分片睡眠保持 uci 可即时停用；LuCI 认证页状态显示全面增强（状态前缀→中文标签+颜色：在线绿/封禁红/其他蓝，原始状态串小字展示，封禁时红字警示勿手动重试） |
| v2.8.1 | 「MAC 生成失败」真正根因修复：v2.8.0 修的是后端随机源（popen 防护/uuid 主源），但用户实测 Network 面板显示 rpcd 应答完全正常（`[0,{"mac":"02eeef99817f"}]`）仍报失败——问题在前端。rpc.js 的 `expect:{'mac':''}` 会把应答**解包**成裸字符串（handleCallReply 里 `ret=ret[key]`），前端 `ret.mac` 取值 undefined→永远走失败分支（livemac 同链路，「WAN 口当前实际 MAC」也因此恒显未知）。改 `expect:{}` 保留完整对象（campusauth 页 2026-09-17 起就是这么写的，MAC 页漏改）；失败通知附带后端 error 原因。教训：rpc.declare 的 expect 每个 key 都是一次解包+类型校验，取对象字段必须空 expect 拿整包 |
