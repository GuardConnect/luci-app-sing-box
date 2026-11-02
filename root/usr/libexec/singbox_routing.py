"""Validated routing builder model. The emitted configuration uses current rule-set APIs."""
import copy
import hashlib
import ipaddress
import re
from urllib.parse import urlsplit

LIST_FIELDS = ('domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'geosite',
               'geoip', 'ip_cidr', 'source_ip_cidr', 'port', 'source_port', 'network', 'protocol', 'rule_set')
BOOL_FIELDS = ('ip_is_private', 'source_ip_is_private')
PROTOCOLS = ('http', 'tls', 'quic', 'dns', 'bittorrent', 'stun', 'dtls', 'ssh', 'rdp', 'ntp')


def defaults():
    return dict(version=1, enabled=True, sniff=True, final='direct', capture_mode='pbr', rule_set_interval=24, mirror='github',
                rules=[], rule_sets=[])


def boolean(value, default=False):
    if value is None:
        return default
    if type(value) is not bool:
        raise ValueError('Routing flags must be boolean')
    return value


def text(value, limit=2048):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ValueError('Invalid routing text')
    return value.strip()


def strings(value):
    if isinstance(value, str):
        value = value.splitlines()
    if not isinstance(value, list) or len(value) > 256:
        raise ValueError('Routing lists support up to 256 entries')
    return list(dict.fromkeys(item for item in (text(value) for value in value) if item))


def outbound(value):
    value = text(value, 64)
    if value not in ('direct', 'block') and not re.fullmatch(r'node:[a-f0-9]{24}', value):
        raise ValueError('Invalid routing outbound')
    return value


def ports(values):
    exact, ranges = [], []
    for value in values:
        if re.fullmatch(r'[0-9]{1,5}', value) and 1 <= int(value) <= 65535:
            exact.append(int(value))
            continue
        match = re.fullmatch(r'([0-9]{1,5})[:-]([0-9]{1,5})', value)
        if not match or not 1 <= int(match[1]) <= int(match[2]) <= 65535:
            raise ValueError('Ports must be 1–65535 or a valid start:end range')
        ranges.append(str(int(match[1])) + ':' + str(int(match[2])))
    return exact, ranges


def normalize(data):
    if not isinstance(data, dict) or set(data) - (set(defaults()) | {'name'}):
        raise ValueError('Invalid routing profile')
    if type(data.get('version', 1)) is not int or data.get('version', 1) != 1:
        raise ValueError('Invalid routing profile')
    result = defaults()
    result.update(enabled=boolean(data.get('enabled'), True), sniff=boolean(data.get('sniff'), True),
                  final=outbound(data.get('final', 'direct')))
    result['capture_mode'] = data.get('capture_mode', 'pbr')
    if result['capture_mode'] not in ('pbr', 'automatic'):
        raise ValueError('Invalid traffic capture mode')
    if result['capture_mode'] == 'automatic' and not result['enabled']:
        raise ValueError('Automatic routes require internal routing to be enabled')
    hours = data.get('rule_set_interval', 24)
    if type(hours) is not int or not 1 <= hours <= 168:
        raise ValueError('Rule-set update interval must be 1–168 hours')
    result['rule_set_interval'] = hours
    result['mirror'] = data.get('mirror', 'github')
    if result['mirror'] not in ('github', 'jsdelivr'):
        raise ValueError('Invalid rule-set mirror')
    sets = data.get('rule_sets', [])
    if not isinstance(sets, list) or len(sets) > 64:
        raise ValueError('At most 64 custom rule-sets are supported')
    tags = set()
    for item in sets:
        if not isinstance(item, dict) or set(item) - {'tag', 'url', 'format'}:
            raise ValueError('Invalid rule-set definition')
        tag, url, form = text(item.get('tag', ''), 80), text(item.get('url', ''), 4096), item.get('format', 'binary')
        parsed = urlsplit(url)
        if not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.@!-]{0,79}', tag) or tag in tags:
            raise ValueError('Rule-set tags must be valid and unique')
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or any(c.isspace() for c in url):
            raise ValueError('Rule-set URL must use HTTPS without credentials or a fragment')
        if form not in ('binary', 'source'):
            raise ValueError('Rule-set format must be binary or source')
        tags.add(tag)
        result['rule_sets'].append(dict(tag=tag, url=url, format=form))
    rules = data.get('rules', [])
    if not isinstance(rules, list) or len(rules) > 200:
        raise ValueError('At most 200 routing rules are supported')
    for index, item in enumerate(rules):
        if not isinstance(item, dict) or set(item) - {'name', 'enabled', 'mode', 'invert', 'match_all', 'outbound', 'conditions'}:
            raise ValueError('Invalid routing rule')
        rule = dict(name=text(item.get('name', ''), 80) or 'Rule ' + str(index + 1),
                    enabled=boolean(item.get('enabled'), True), mode=item.get('mode', 'and'),
                    invert=boolean(item.get('invert')), match_all=boolean(item.get('match_all')),
                    outbound=outbound(item.get('outbound', 'direct')), conditions={})
        if rule['mode'] not in ('and', 'or'):
            raise ValueError('Rule mode must be AND or OR')
        conditions = item.get('conditions', {})
        if not isinstance(conditions, dict) or set(conditions) - set(LIST_FIELDS + BOOL_FIELDS + ('ip_version',)):
            raise ValueError('Unsupported routing condition')
        for key in LIST_FIELDS:
            values = strings(conditions.get(key, []))
            if not values:
                continue
            if key in ('geosite', 'geoip'):
                values = [s.removeprefix(key + ':').removeprefix(key + '-').lower() for s in values]
                if any(not re.fullmatch('[a-z0-9][a-z0-9_.@!-]{0,79}', value) for value in values):
                    raise ValueError('Invalid geosite or geoip category')
            if key in ('ip_cidr', 'source_ip_cidr'):
                try:
                    values = [str(ipaddress.ip_network(value, strict=False)) for value in values]
                except ValueError:
                    raise ValueError('Invalid routing IP address or subnet') from None
            if key in ('port', 'source_port'):
                ports(values)
            if key == 'network' and any(value not in ('tcp', 'udp', 'icmp') for value in values):
                raise ValueError('Network must be tcp, udp or icmp')
            if key == 'protocol' and any(value not in PROTOCOLS for value in values):
                raise ValueError('Unsupported sniffed protocol')
            if key == 'rule_set' and any(value not in tags for value in values):
                raise ValueError('A referenced custom rule-set is not defined')
            rule['conditions'][key] = values
        for key in BOOL_FIELDS:
            if boolean(conditions.get(key)):
                rule['conditions'][key] = True
        ip_version = conditions.get('ip_version')
        if ip_version not in (None, '') and (type(ip_version) is not int or ip_version not in (0, 4, 6)):
            raise ValueError('IP version must be 4 or 6')
        if conditions.get('ip_version'):
            rule['conditions']['ip_version'] = conditions['ip_version']
        if not rule['conditions'] and not rule['match_all']:
            raise ValueError('Add a condition or explicitly match all traffic')
        result['rules'].append(rule)
    return result


def references(profile):
    if not profile.get('enabled'):
        return set()
    return {value[5:] for value in [profile.get('final', 'proxy')] + [r['outbound'] for r in profile.get('rules', []) if r.get('enabled', True)] if value.startswith('node:')}


def compile_profile(data, base, nodes, settings, store, paths=None, force=False):
    """Return generated config and required remote sets, keeping managed DNS first."""
    profile = normalize(data)
    config = copy.deepcopy(base)
    if not profile['enabled'] and not force:
        return config, []
    if profile['capture_mode'] == 'automatic':
        for inbound in config['inbounds']:
            if inbound.get('type') == 'tun':
                inbound.update(auto_route=True, auto_redirect=True, strict_route=False, stack='gvisor',
                               dns_mode='disabled' if settings.get('dns_mode') == 'https_dns_proxy' else 'hijack',
                               route_exclude_address=['0.0.0.0/8', '240.0.0.0/4', '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '224.0.0.0/4'])
        # auto_redirect manages its own marks; explicit routing_mark conflicts with it.
        for item in config['outbounds']:
            item.pop('routing_mark', None)
    index = {node['id']: node for node in nodes}
    sets = {item['tag']: dict(item) for item in profile['rule_sets']}
    used = set()
    extra = set()

    def target(value):
        if not value.startswith('node:'):
            return value
        ident = value[5:]
        if ident not in index:
            raise ValueError('A server used by routing is missing from subscriptions')
        tag = 'route-node-' + ident
        if tag not in extra:
            proxy = copy.deepcopy(index[ident]['outbound'])
            proxy.update(tag=tag, bind_interface=settings['uplink'], routing_mark=0,
                         domain_resolver=config['outbounds'][0]['domain_resolver'])
            if profile['capture_mode'] == 'automatic':
                proxy.pop('routing_mark', None)
            config['outbounds'].append(proxy)
            extra.add(tag)
        return tag

    def action(value):
        return dict(action='reject', method='default') if value == 'block' else dict(action='route', outbound=target(value))

    result = list(config['route']['rules'])
    if profile['sniff']:
        result.append(dict(inbound=['tun-in'], action='sniff', timeout='300ms'))
    for rule in profile['rules']:
        if not rule['enabled']:
            continue
        matches = []
        for key, value in ({} if rule['match_all'] else rule['conditions']).items():
            if key in ('geosite', 'geoip'):
                tags = []
                for category in value:
                    tag = key + '-' + category
                    prefix = 'https://raw.githubusercontent.com/SagerNet/sing-' + key + '/rule-set/' if profile['mirror'] == 'github' else 'https://cdn.jsdelivr.net/gh/SagerNet/sing-' + key + '@rule-set/'
                    definition = dict(tag=tag, format='binary', url=prefix + tag + '.srs')
                    if tag in sets and sets[tag] != definition:
                        raise ValueError('Custom rule-set conflicts with a built-in category')
                    sets[tag] = definition
                    tags.append(tag)
                matches.append(dict(rule_set=tags))
                used.update(tags)
            elif key in ('port', 'source_port'):
                exact, ranges = ports(value)
                condition = {}
                if exact:
                    condition[key] = exact
                if ranges:
                    condition[key + '_range'] = ranges
                matches.append(condition)
            else:
                matches.append({key: value})
                if key == 'rule_set':
                    used.update(value)
        if rule['match_all']:
            matches = [dict(inbound=['tun-in'])]
        if rule['mode'] == 'and':
            # Throne emits one native default rule. Sing-box groups destination
            # matchers (domain/suffix/regex/IP), source IP matchers, and ports.
            # Splitting these into logical AND children changes their meaning.
            inner = {}
            for condition in matches:
                for key, value in condition.items():
                    if key in inner and isinstance(value, list):
                        inner[key] = list(dict.fromkeys(inner[key] + value))
                    else:
                        inner[key] = value
            inner['invert'] = rule['invert']
        else:
            # Explicit UI OR remains an extension: any populated field matches.
            inner = dict(type='logical', mode='or', rules=matches, invert=rule['invert'])
        outer = dict(type='logical', mode='and', rules=[dict(inbound=['tun-in']), inner])
        outer.update(action(rule['outbound']))
        result.append(outer)
    if profile['final'] == 'block':
        result.append(dict(inbound=['tun-in'], action='reject', method='default'))
        config['route']['final'] = 'direct'
    else:
        config['route']['final'] = target(profile['final'])
    if settings.get('dns_mode') == 'external' and settings.get('dns_detour') == 'proxy':
        for server in config['dns']['servers']:
            if server.get('tag') == 'remote':
                server['detour'] = target(profile['final']) if profile['final'].startswith('node:') else 'direct'
    config['route']['rules'] = result
    required = []
    if len(used) > 64:
        raise ValueError('At most 64 rule-sets may be used by a profile')
    for tag in sorted(used):
        entry = dict(sets[tag])
        entry['path'] = str(store / 'rule-sets' / (hashlib.sha256(entry['url'].encode()).hexdigest() + ('.srs' if entry['format'] == 'binary' else '.json')))
        required.append(entry)
    if required:
        config['route']['rule_set'] = [dict(type='remote', tag=item['tag'], format=item['format'], url=item['url'],
              initial_path=(paths or {}).get(item['tag'], item['path']), http_client=dict(detour='direct'),
              update_interval=str(profile['rule_set_interval']) + 'h') for item in required]
        config.setdefault('experimental', {})['cache_file'] = dict(enabled=True, path=str(store / 'rule-set-cache.db'))
    return config, required
