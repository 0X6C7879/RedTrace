import unittest
import tempfile
import tarfile
import io
from pathlib import Path
from types import SimpleNamespace
from knowledge import cpe_fields, compare, evaluate, version_match, affected_versions, import_package

CPE = 'cpe:2.3:a:acme:widget:*:*:*:*:*:*:*:*'
def observation(version='1.5'):
    return {'component': 'Widget', 'product': 'widget', 'vendor': 'acme', 'part': 'a', 'version': version}
def rule(**bounds):
    return {'vulnerable': True, 'criteria': CPE, **bounds}

class OfflineMatchingTests(unittest.TestCase):
    def test_boundaries_and_disjoint_ranges(self):
        config = [{'nodes': [{'operator': 'OR', 'cpeMatch': [rule(versionStartIncluding='1.0', versionEndExcluding='2.0'), rule(versionStartExcluding='3.0', versionEndIncluding='4.0')]}]}]
        for version, expected in [('1.0', True), ('1.9', True), ('2.0', False), ('2.5', False), ('3.0', False), ('3.1', True), ('4.0', True), ('4.1', False), (None, None)]:
            self.assertIs(evaluate(config, [observation(version)]), expected)

    def test_unknown_version_scheme_is_not_excluded(self):
        self.assertIsNone(version_match(rule(versionEndIncluding='1.2b'), observation('1.2a'), '*'))
        self.assertIsNone(compare('1.2a', '1.2b'))
        self.assertEqual(compare('1.0.0+abc', '1.0.0+def', 'semver'), 0)
        self.assertLess(compare('1.0.0-rc.1', '1.0.0', 'semver'), 0)

    def test_environment_and_negation(self):
        environment = {'criteria': 'cpe:2.3:o:acme:system:4.0:*:*:*:*:*:*:*', 'vulnerable': False}
        tree = {'operator': 'AND', 'nodes': [{'operator': 'OR', 'cpeMatch': [rule(versionEndExcluding='2.0')]}, {'operator': 'OR', 'cpeMatch': [environment]}]}
        self.assertIsNone(evaluate(tree, [observation()]))
        system = {'component': 'system', 'product': 'system', 'vendor': 'acme', 'part': 'o', 'version': '4.0'}
        self.assertIs(evaluate(tree, [observation(), system]), True)
        self.assertIs(evaluate(tree, [observation('2.5'), system]), False)
        self.assertIsNone(evaluate({'negate': True, 'cpeMatch': [rule()]}, [observation(None)]))

    def test_cpe_na_and_official_cisco_literal(self):
        fields = cpe_fields('cpe:2.3:o:cisco:ios:15.2(7)e13:*:*:*:*:*:*:*')
        self.assertEqual(fields['version'], '15.2(7)e13')
        self.assertIs(version_match({}, observation('1.0'), '-'), False)
        self.assertIsNone(version_match({}, observation(None), '-'))

    def test_numeric_segments_and_openssl_are_not_decimal_fractions(self):
        self.assertGreater(compare('9.0.90', '9.0.9'), 0)
        self.assertGreater(compare('1.10', '1.1'), 0)
        self.assertEqual(compare('1.0', '1.0.0'), 0)
        self.assertLess(compare('1.0.1f', '1.0.1g', 'openssl'), 0)
        self.assertLess(compare('1.0.1', '3.0.0', 'openssl'), 0)
        configuration = [{'nodes': [{'cpeMatch': [dict(rule(), criteria='cpe:2.3:a:apache:tomcat:9.0.9:*:*:*:*:*:*:*')]}]}]
        state, ranges = affected_versions(configuration, [{'component': 'tomcat', 'version': '9.0.90'}])
        self.assertEqual(state, 'not_affected')

    def test_flattened_version_preview_never_excludes_a_negated_configuration(self):
        configuration = {"negate": True, "cpeMatch": [rule(versionEndExcluding="2.0")]}
        state, _ = affected_versions(configuration, [observation("2.5")])
        self.assertEqual(state, "unknown")
        self.assertIs(evaluate(configuration, [observation("2.5")]), True)

    def test_import_rejects_archive_traversal_before_writing_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); package = root / "bad.tar.gz"
            with tarfile.open(package, "w:gz") as archive:
                item = tarfile.TarInfo("../escape"); item.size = 4
                archive.addfile(item, io.BytesIO(b"bad!"))
            with self.assertRaisesRegex(ValueError, "Unsafe archive member"):
                import_package(SimpleNamespace(root=str(root / "data"), package=str(package), allow_partial=False))
            self.assertFalse((root / "escape").exists())


if __name__ == '__main__': unittest.main()
