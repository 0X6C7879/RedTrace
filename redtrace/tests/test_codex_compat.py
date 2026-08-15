from redtrace.dispatcher.workers.codex_compat import normalize_response_input


def test_normalizes_structured_function_output_for_compatible_providers() -> None:
    body = {
        "input": [
            {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": [
                    {"type": "input_text", "text": "first"},
                    {"type": "input_text", "text": "second"},
                ],
            }
        ]
    }

    normalize_response_input(body)

    assert body["input"][0]["output"] == "first\nsecond"
