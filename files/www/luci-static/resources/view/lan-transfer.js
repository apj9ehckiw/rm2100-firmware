'use strict';
'require view';
'require form';
'require uci';
'require network';

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('lan-transfer'),
			network.getNetwork('lan')
		]);
	},

	render: function(data) {
		var lan = data[1],
		    ip = lan ? lan.getIPAddr() : null,
		    enabled = uci.get('lan-transfer', 'main', 'enabled') != '0',
		    port = uci.get('lan-transfer', 'main', 'port') || '8080',
		    url = ip ? 'http://' + ip + ':' + port + '/' : null,
		    m, s, o;

		m = new form.Map('lan-transfer', _('内网文件互传'),
			_('同一路由器下的手机、电脑打开互传页面，就能看到彼此并直接发送文件和文字，不用装应用、不用登录后台。文件优先在设备之间直连传输，直连不通时经路由器分块中转，不占用路由器存储。'));

		s = m.section(form.NamedSection, 'main', 'lan-transfer');
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('启用'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'port', _('页面端口'),
			_('互传页面只监听 LAN 口地址，不会向外网开放。'));
		o.datatype = 'port';
		o.placeholder = '8080';
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (value == '80' || value == '443')
				return _('80 和 443 被管理后台占用，请换一个端口');
			return true;
		};

		return m.render().then(function(mapEl) {
			var link = E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('打开互传页面') ]),
				url && enabled
					? E('p', {}, [
						E('a', {
							'class': 'btn cbi-button cbi-button-action',
							'href': url,
							'target': '_blank',
							'rel': 'noopener noreferrer'
						}, [ _('打开 %s').format(url) ])
					])
					: E('p', {}, [ enabled ? _('LAN 口暂无 IPv4 地址，请检查网络设置。') : _('功能已关闭，勾选“启用”并保存应用后可用。') ]),
				E('p', { 'class': 'cbi-section-descr' }, [
					_('在另一台设备的浏览器输入上面的地址，或在互传页面点“邀请设备”扫码打开。修改端口后请保存并应用。')
				])
			]);
			return E([], [ link, mapEl ]);
		});
	}
});
