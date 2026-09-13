# RM2100 固件构建（GitHub Actions）

红米 RM AC2100（MediaTek MT7621A，128MB RAM / 16MB flash）专用 OpenWrt 固件，
内置**校园网多设备检测规避**（TTL 归一化），通过 GitHub Actions 云端构建，
本机无需 Linux 环境。

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
   默认参数（24.10.2 + LuCI）直接点 Run。约 3-5 分钟出包。

3. 在该次运行页面下载 artifact `rm2100-firmware-24.10.2`，解压得到：
   - `openwrt-*-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-kernel1.bin`
   - `openwrt-*-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-rootfs0.bin`
   - `openwrt-*-ramips-mt7621-xiaomi_redmi-router-ac2100-squashfs-sysupgrade.bin`
   - `sha256sums`

   > RM AC2100 是 NAND 闪存设备，OpenWrt 官方**不产出 factory.bin**，
   > breed 刷机用 kernel1.bin（内核）+ rootfs0.bin（根文件系统）两个文件分别刷。

## 校验

对比 artifact 内 `sha256sums` 与本地 `sha256sum` 输出一致再刷机。

## 固件内置的规避规则

| 检测手段 | 对策 |
|---|---|
| TTL 检测 | `/etc/nftables.d/10-campus-ttl-fix.nft`：WAN 出方向 IPv4 TTL / IPv6 hoplimit 强制 64 |
| IP-MAC 绑定 | NAT 天然只暴露路由器 WAN 口 MAC，无需额外配置 |
| 在线客户端数 | 只有路由器本身参与认证，天然规避 |
| UA/系统指纹 | 路由器层面无法解决，需各终端浏览器处理（见下方说明） |

**TTL 目标值**：默认 64（Linux/Mac/Android 指纹）。如果校园网期望的是 Windows
主机（128），登录 LuCI → System → TTYD 终端（或 ssh）修改
`/etc/nftables.d/10-campus-ttl-fix.nft` 里两处 `64` 为 `128`，执行
`service firewall restart`。

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
- **如果改 TTL 后仍被踢**：可能检测的是 IP-ID 熵或 HTTP X-Online-Host 之类的
  深度特征，此时需要更复杂的 nft 规则，反馈后再加。
- **128MB 内存提醒**：AC2100 只有 128MB RAM，LuCI + 无线全开时余量不多。
  不要装 docker / 大型插件，qm-buff 之类坑内存的包别上。
- workflow 里 `PACKAGES` 默认追加 `kmod-ipt-nat ip6tables-nft iptables-nft`
  是为了兼容习惯用 `iptables -t mangle` 的老脚本；nft 路径用上面文件即可。
