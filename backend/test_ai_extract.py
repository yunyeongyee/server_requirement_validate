import io
import unittest
from unittest.mock import patch

from . import ai_extract
from . import extract


def ai_item(
    evidence,
    *,
    classification="requirement",
    category="memory",
    key="memory_gb",
    value=64,
    quantity=8,
    unit="GB",
    confidence=0.95,
    attributes=None,
):
    return {
        "classification": classification,
        "category": category,
        "key": key,
        "label": "Memory",
        "canonical": "64GB RDIMM",
        "value": value,
        "unit": unit,
        "quantity": quantity,
        "op": ">=",
        "attributes": attributes or {
            "unit_size_gb": 64,
            "speed_gb": None,
            "ports_per_unit": None,
            "socket_count": None,
        },
        "confidence": confidence,
        "evidence": evidence,
    }


class AdaptiveExtractionTests(unittest.TestCase):
    def test_effort_escalates_for_cross_sheet_context(self):
        text = "Summary 요약: DB 서버 공통 옵션은 Sheet 2 참조"
        context = {"sheets": [{"name": "Summary"}, {"name": "Detail"}]}
        self.assertEqual(ai_extract.choose_effort(text, context, []), "medium")

    def test_effort_uses_low_for_local_hardware_normalization(self):
        text = "PLAN EP E810-XXVDA2 2X 25G SFP28 PCIe LP"
        self.assertEqual(ai_extract.choose_effort(text, None, []), "low")

    def test_clear_requirement_stays_on_rules_path(self):
        self.assertIsNone(ai_extract.choose_effort("Memory 512GB 이상", None, []))

    def test_group_quantity_requires_explicit_server_count_evidence(self):
        corpus = "DB 서버 2대"
        self.assertTrue(ai_extract._quantity_is_supported(2, corpus, corpus.casefold()))
        self.assertFalse(ai_extract._quantity_is_supported(2, "DB 서버 Memory 256GB", corpus.casefold()))

    def test_low_effort_sends_only_local_hardware_excerpt(self):
        text = "DB 서버 요구사항\nMemory 512GB 이상\n\nPLAN EP E810-XXVDA2 2X 25G SFP28 PCIe LP\n견적 비고"
        excerpt, context = ai_extract._model_input(text, None, [], "low")
        self.assertIn("E810-XXVDA2", excerpt)
        self.assertNotIn("Memory 512GB", excerpt)
        self.assertIsNone(context)

    def test_disabled_ai_does_not_call_provider(self):
        groups = [{"id": "server-1", "name": "서버 1", "requirements": [], "spec": []}]
        with patch.dict("os.environ", {"SRV_AI_ENABLED": "false", "OPENAI_API_KEY": "test", "SRV_AI_MODEL": "test"}):
            with patch.object(ai_extract, "_request_openai") as request:
                actual, info = ai_extract.extract_groups("PLAN EP E810-XXVDA2 25G NIC", None, groups)
        request.assert_not_called()
        self.assertIs(actual, groups)
        self.assertEqual(info["mode"], "rules")

    def test_provider_error_returns_rules_with_visible_notice(self):
        groups = [{"id": "server-1", "name": "서버 1", "requirements": [], "spec": []}]
        text = "PLAN EP E810-XXVDA2 2X 25G SFP28 PCIe LP"
        with patch.dict("os.environ", {
            "SRV_AI_ENABLED": "true",
            "OPENAI_API_KEY": "test",
            "SRV_AI_MODEL": "test-model",
        }):
            with patch.object(ai_extract, "_request_openai", side_effect=ai_extract.AIExtractionError("test")):
                actual, info = ai_extract.extract_groups(text, None, groups)
        self.assertIs(actual, groups)
        self.assertEqual(info["mode"], "rules_fallback")
        self.assertTrue(info["notice"])

    def test_low_confidence_result_escalates_once_to_medium(self):
        text = "PLAN EP E810-XXVDA2 2X 25G SFP28 PCIe LP"
        part_attributes = {
            "unit_size_gb": None, "speed_gb": 25, "ports_per_unit": 2, "socket_count": None,
        }
        low_result = {"groups": [{
            "name": "DB 서버", "quantity": None, "evidence": text,
            "quantity_evidence": None, "confidence": 0.9,
            "items": [ai_item(
                text, classification="quote", category="nic", key=None, quantity=None,
                confidence=0.6, attributes=part_attributes,
            )],
        }]}
        medium_result = {"groups": [{
            "name": "DB 서버", "quantity": None, "evidence": text,
            "quantity_evidence": None, "confidence": 0.95,
            "items": [ai_item(
                text, classification="quote", category="nic", key=None, quantity=None,
                confidence=0.95, attributes=part_attributes,
            )],
        }]}
        rule_groups = [{"id": "server-1", "name": "서버 1", "requirements": [], "spec": []}]
        with patch.dict("os.environ", {
            "SRV_AI_ENABLED": "true",
            "OPENAI_API_KEY": "test",
            "SRV_AI_MODEL": "test-model",
        }):
            with patch.object(ai_extract, "_request_openai", side_effect=[low_result, medium_result]) as request:
                _, info = ai_extract.extract_groups(text, None, rule_groups)
        self.assertEqual([call.args[2] for call in request.call_args_list], ["low", "medium"])
        self.assertEqual(info, {"mode": "ai", "effort": "medium", "escalated": True})

    def test_memory_total_is_calculated_in_python(self):
        item = ai_item("64GB RDIMM x 8")
        converted = ai_extract._to_requirement(item, item["evidence"])
        self.assertEqual(converted["value"], 512)
        self.assertEqual(converted["status"], "auto")

    def test_low_confidence_requirement_requires_review(self):
        item = ai_item("64GB RDIMM x 8", confidence=0.6)
        converted = ai_extract._to_requirement(item, item["evidence"])
        self.assertEqual(converted["status"], "review")

    def test_unverified_evidence_is_rejected(self):
        result = {"groups": [{
            "name": "DB 서버",
            "quantity": None,
            "evidence": "DB 서버",
            "quantity_evidence": None,
            "confidence": 0.9,
            "items": [ai_item("256GB that is not in source")],
        }]}
        with self.assertRaises(ai_extract.AIExtractionError):
            ai_extract._validate_and_convert(result, "DB 서버\nMemory 512GB", None)

    def test_configuration_does_not_become_requirement(self):
        evidence = "견적 구성: Broadcom 25GbE 2Port NIC"
        item = ai_item(evidence, classification="quote", category="nic", key=None, quantity=None)
        item["attributes"] = {
            "unit_size_gb": None, "speed_gb": 25, "ports_per_unit": 2, "socket_count": None,
        }
        result = {"groups": [{
            "name": "DB 서버", "quantity": None, "evidence": evidence,
            "quantity_evidence": None, "confidence": 0.9, "items": [item],
        }]}
        groups = ai_extract._validate_and_convert(result, evidence, None)
        self.assertEqual(groups[0]["requirements"], [])
        self.assertEqual(groups[0]["spec"][0]["items"][0]["kind"], "quote")

    def test_xlsx_context_preserves_sheet_names_and_nonempty_rows(self):
        import openpyxl

        workbook = openpyxl.Workbook()
        workbook.active.title = "Summary"
        workbook.active.append(["DB 서버", "2대"])
        detail = workbook.create_sheet("Detail")
        detail.append(["품목", "수량"])
        detail.append(["64GB RDIMM", 8])
        stream = io.BytesIO()
        workbook.save(stream)
        context = extract.extract_document_context("test.xlsx", stream.getvalue())
        self.assertEqual([sheet["name"] for sheet in context["sheets"]], ["Summary", "Detail"])
        self.assertEqual(context["sheets"][1]["rows"][1]["cells"], ["64GB RDIMM", "8"])

    def test_rule_conflict_is_retained_for_review(self):
        evidence = "Memory 512GB 이상"
        ai_groups = [{
            "id": "server-1", "name": "DB 서버", "quantity": None, "confidence": 0.9,
            "requirements": [{
                "id": "ai-1", "key": "memory_gb", "op": ">=", "value": 256,
                "source": evidence, "status": "auto", "note": "",
            }],
            "spec": [],
            "_ai_evidence": [evidence],
        }]
        rule_groups = [{
            "id": "server-1",
            "name": "서버 1",
            "requirements": [{
                "id": "rule-1", "key": "memory_gb", "label": "Memory", "op": ">=",
                "value": 512, "unit": "GB", "source": evidence, "status": "auto", "note": "",
            }],
            "spec": [],
        }]
        merged = ai_extract._merge_rule_results(rule_groups, ai_groups)
        preserved = next(item for item in merged[0]["requirements"] if item["value"] == 512)
        self.assertEqual(preserved["status"], "review")
        self.assertEqual(preserved["value"], 512)


if __name__ == "__main__":
    unittest.main()


class RedactTests(unittest.TestCase):
    def test_masks_credentials_and_ip_but_keeps_specs(self):
        text = ("CPU : Intel Xeon Gold 6544Y 16C 3.6GHz\nID KF21TimsSdd admin\nPW TimsKF21@ Admin-N8gHcj5k52t.\n"
                "iRMC IP 192.168.10.100\nX710-DA4 4port 10Gb SFP")
        out = ai_extract.redact({"source_text": text, "cells": ["Admin-zP5Sh4kz1JmS", "DDR5-4800 64GB"]})
        joined = out["source_text"] + " ".join(out["cells"])
        for secret in ("KF21TimsSdd", "TimsKF21@", "Admin-N8gHcj5k52t.", "192.168.10.100", "Admin-zP5Sh4kz1JmS"):
            self.assertNotIn(secret, joined)
        for spec in ("Xeon Gold 6544Y", "X710-DA4", "DDR5-4800 64GB", "3.6GHz"):
            self.assertIn(spec, joined)

