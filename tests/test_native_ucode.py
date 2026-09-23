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
function readfile(path) {
    if (path == '/proc/sys/kernel/random/uuid')
        return 'a1b2c3d4-e5f6-4718-893a-4b5c6d7e8f90';
    return null;
}
function cursor() {
    return { get: function(c, s, o) {
        return { username: "user'one", password: "O'br'ien&+% ?", portal_ip: '10.1.110.2' }[o];
    } };
}
function popen(cmd) {
    push(commands, cmd);
    let out = '';
    if (cmd == 'command -v curl 2>/dev/null') out = '/usr/bin/curl';
    else if (match(cmd, /PortalJsonAction[.]do/))
        out = '{"timestamp":"1000","uuid":"u1","serverip":"10.1.110.3","wlanuserip":"10.9.9.9","wlanacname":"AC1","mac":"aa:bb:cc:dd:ee:ff","vlan":"9"}';
    else if (match(cmd, /quickauth/)) out = '{"code":"0","message":null}';
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
''',
    '95-campus-mac-luci': r'''
let mac = plugin.campusmac.rotate.call({}, {}).mac;
assert(match(mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/), 'invalid MAC format');
assert((hexdec(substr(mac, 0, 2)) & 3) == 0, 'MAC must remain globally administered unicast');
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
