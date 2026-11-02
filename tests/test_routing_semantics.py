"""Routing JSON contracts shared with Throne's native Sing-Box rules."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('routing', Path(__file__).resolve().parents[1] / 'root/usr/libexec/singbox_routing.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RoutingSemanticsTests(unittest.TestCase):
    def compile(self, rules, **options):
        profile = dict(r.defaults(), rules=rules, **options)
        base = dict(inbounds=[], outbounds=[dict(type='direct', tag='direct')], route=dict(rules=[]))
        return r.compile_profile(profile, base, [], {}, Path('/tmp/test-routing'))[0]['route']

    def test_native_groups_and_inversion(self):
        conditions = dict(domain=['a.test'], domain_suffix=['b.test'], port=['443', '8000-9000'])
        rule = self.compile([dict(conditions=conditions, invert=True)])['rules'][1]
        self.assertEqual(rule['rules'][0], dict(inbound=['tun-in']))
        self.assertEqual(rule['rules'][1], dict(domain=['a.test'], domain_suffix=['b.test'], port=[443], port_range=['8000:9000'], invert=True))

    def test_explicit_or_preserved(self):
        rule = self.compile([dict(mode='or', conditions=dict(domain=['a.test'], port=['443']))])['rules'][1]
        self.assertEqual(rule['rules'][1], dict(type='logical', mode='or', rules=[dict(domain=['a.test']), dict(port=[443])], invert=False))

    def test_categories_merge_without_overwriting(self):
        route = self.compile([dict(conditions=dict(geosite=['google'], geoip=['de'], rule_set=['custom']))], rule_sets=[dict(tag='custom', url='https://example.test/set.srs')])
        self.assertEqual(route['rules'][1]['rules'][1]['rule_set'], ['geosite-google', 'geoip-de', 'custom'])
        self.assertEqual(len(route['rule_set']), 3)

    def test_order_disabled_and_match_all(self):
        route = self.compile([dict(enabled=False, match_all=True, outbound='block'), dict(match_all=True, outbound='direct'), dict(conditions=dict(domain=['a.test']), outbound='block')], final='block')
        self.assertEqual([x['action'] for x in route['rules']], ['sniff', 'route', 'reject', 'reject'])
        self.assertEqual(route['rules'][1]['rules'][1], dict(inbound=['tun-in'], invert=False))

    def test_numeric_types_are_strict(self):
        for value in (True, 1.0, '1'):
            with self.subTest(version=value), self.assertRaises(ValueError):
                r.normalize(dict(version=value))
        for value in (False, 4.0, '4'):
            with self.subTest(ip_version=value), self.assertRaises(ValueError):
                r.normalize(dict(rules=[dict(conditions=dict(ip_version=value))]))


if __name__ == '__main__':
    unittest.main()
