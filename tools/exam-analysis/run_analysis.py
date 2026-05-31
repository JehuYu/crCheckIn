from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path


TOOL_DIR = Path(__file__).resolve().parent
VENDOR_XLRD = TOOL_DIR / "vendor_xlrd"

sys.path.insert(0, str(TOOL_DIR))
if VENDOR_XLRD.exists():
    sys.path.insert(0, str(VENDOR_XLRD))

import pandas as pd  # noqa: E402

import analyze_exam_data  # noqa: E402


def dataframe_to_json(df: pd.DataFrame, index_name: str = "班级") -> dict:
    rows = []
    for idx, row in df.iterrows():
        row_data = {index_name: str(idx)}
        for col in df.columns:
            value = row[col]
            if pd.isna(value):
                row_data[str(col)] = None
            elif isinstance(value, (int, float, str, bool)):
                row_data[str(col)] = value
            else:
                row_data[str(col)] = str(value)
        rows.append(row_data)
    return {"columns": [index_name] + [str(col) for col in df.columns], "data": rows}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run exam question-score analysis.")
    parser.add_argument("--input", required=True, help="Path to the uploaded Excel file.")
    parser.add_argument("--output", required=True, help="Path for the generated analysis workbook.")
    parser.add_argument("--mapping", help="Optional class assignment workbook for this analysis run.")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    mapping_path = Path(args.mapping).resolve() if args.mapping else None
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        result = analyze_exam_data.process_exam_file(str(input_path), str(mapping_path) if mapping_path else analyze_exam_data.CLASS_ASSIGNMENT_FILE)
        analyze_exam_data.save_analysis_to_excel(result, str(output_path))
        payload = {
            "ok": True,
            "summary": result.summary,
            "warnings": result.schema.warnings,
            "class_averages": dataframe_to_json(result.class_averages),
            "info_analysis": dataframe_to_json(result.info_analysis),
            "general_analysis": dataframe_to_json(result.general_analysis),
        }
        print(json.dumps(payload, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
