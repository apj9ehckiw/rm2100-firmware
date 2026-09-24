"""Native ucode smoke test; UCODE_BIN selects the matching firmware interpreter.

Replace only fs/uci I/O with stubs. All syntax, builtins and RPC logic run in
ucode itself, so a JavaScript shim cannot hide an unsupported builtin.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
stub = r'''
let commands = [];
let files = {};
let auth_reply = '{"code":"0","message":null}';
let now = 1000;
function readfile(path) {
    if (path == '/proc/sys/kernel/random/uuid')
        return 'a1b2c3d4-e5f6-4718-893a-4b5c6d7e8f90';
    return files[path] ?? null;
}
function cursor() {
    return { get: function(c, s, o) {
        return { username: "user'one", password: "O'br'ien&+% ?", portal_ip: '10.1.110.2', day_1: '1' }[o];
    } };
}
function popen(cmd) {
    push(commands, cmd);
    let out = '';
    if (cmd == 'command -v curl 2>/dev/null') out = '/usr/bin/curl';
    else if (cmd == 'date +%s') out = '' + now;
    else if (substr(cmd, 0, 5) == 'echo ') out = now + ' 00:47:40';
    else if (substr(cmd, 0, 8) == 'date -d ') out = '2026-09-24 12:00:00';
    else if (substr(cmd, 0, 10) == 'umask 077;') out = 'saved';
    else if (match(cmd, /PortalJsonAction[.]do/))
        out = '{"timestamp":"1000","uuid":"u1","serverip":"10.1.110.3","wlanuserip":"10.9.9.9","wlanacname":"AC1","mac":"aa:bb:cc:dd:ee:ff","vlan":"9"}';
    else if (match(cmd, /quickauth/)) out = auth_reply;
    else if (match(cmd, /portal[.]do[?]/)) out = '<link href="/style.css"><script src="/portal.js"></script>';
    else if (match(cmd, /3[.]3[.]3[.]3/))
        out = '<script>location="http://10.1.110.2/portal.do?wlanuserip=10.9.9.9&wlanacname=AC1&mac=aa:bb:cc:dd:ee:ff&vlan=9";</script>';
    return { read: function() { return out; }, close: function() {} };
}
'''

checks = {
    '93-campus-auth': r'''
let login = plugin.campusauth.login.call({}, {});
assert(login.code == '0', 'native login failed');
let requests = filter(commands, cmd => substr(cmd, 0, 5) == 'curl ');
assert(length(requests) == 6, 'portal assets were not loaded');
assert(index(requests[length(requests) - 1], 'passwd=O%27br%27ien%26%2B%25%20%3F') >= 0, 'password encoding');
let logout = plugin.campusauth.logout.call({}, {});
assert(logout.code == '0', 'native logout failed');
commands = [];
auth_reply = '{"code":"-1","message":"发现您当前网络环境存在代理行为,禁用认证30分钟"}';
let banned = plugin.campusauth.login.call({}, {});
assert(banned.code == '-1', 'ban reply lost');
assert(length(filter(commands, cmd => index(cmd, "printf '%s\\n' '2860'") >= 0)) == 1,
       'ban deadline not persisted with 60 second margin');
assert(length(filter(commands, cmd => index(cmd, 'cooldown=persistent') >= 0)) == 1,
       'manual ban log missing');
files['/etc/campus-auth.banuntil'] = '500';
files['/tmp/campus-auth.banuntil'] = '2860';
files['/tmp/campus-auth.status'] = 'banned（手动认证收到封禁）';
commands = [];
assert(plugin.campusauth.login.call({}, {}).error != null, 'repeat login not blocked');
assert(length(filter(commands, cmd => substr(cmd, 0, 5) == 'curl ')) == 0, 'blocked login sent requests');
now = 2860;
let status = plugin.campusauth.status.call({}, {});
assert(index(status.status, 'ban-expired') == 0, 'expired status stale');
assert(length(status.days) == 1 && status.days[0] == '1', 'status weekday filtering failed');
auth_reply = '{"code":"0","message":null}';
assert(plugin.campusauth.login.call({}, {}).code == '0', 'login still blocked after deadline');
''',
    '95-campus-mac-luci': r'''
let mac = plugin.campusmac.rotate.call({}, {}).mac;
assert(match(mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/), 'invalid MAC format');
assert((int(substr(mac, 0, 2), 16) & 3) == 0, 'MAC must remain globally administered unicast');
assert(mac == '3c:fd:fe:a1:b2:c3', 'wrong OUI selection or hex conversion');
''',
}

with tempfile.TemporaryDirectory(prefix='campus-native-') as temp:
    for filename, checks_code in checks.items():
        src = (root / 'files/etc/uci-defaults' / filename).read_text(encoding='utf-8')
        uc = re.search(r"<<'UCEOF'\n(.*?)\nUCEOF", src, re.S)[1]
        uc = re.sub(r'^import .*?;', '', uc, flags=re.M)
        script = Path(temp) / (filename + '.uc')
        script.write_text(stub + '\nlet plugin = (function() {\n' + uc + '\n})();\n' + checks_code,
                          encoding='utf-8', newline='\n')
        subprocess.run([os.environ.get('UCODE_BIN', 'ucode'), str(script)], check=True)
        print(filename + ': native ucode PASS')
