#!/usr/bin/env python3
"""Import the seat map grid and seat-range teams into ignored local-data JSON."""

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkg": "http://schemas.openxmlformats.org/package/2006/relationships",
}
SEAT = re.compile(r"^Z(\d{3})$")
RANGE = re.compile(r"Z(\d{3})\s*[-–]\s*Z?(\d{3})", re.IGNORECASE)
CELL = re.compile(r"([A-Z]+)(\d+)$")


def column_number(letters):
    number = 0
    for char in letters:
        number = number * 26 + ord(char) - 64
    return number


def sheet_rows(archive, sheet_path, shared_strings):
    root = ET.fromstring(archive.read(sheet_path))
    rows = []
    for row in root.findall(".//main:sheetData/main:row", NS):
        values = {}
        for cell in row.findall("main:c", NS):
            address = cell.attrib.get("r", "")
            match = CELL.match(address)
            if not match:
                continue
            value = cell.find("main:v", NS)
            inline = cell.find("main:is", NS)
            text = value.text if value is not None else ""
            if inline is not None:
                text = "".join(node.text or "" for node in inline.findall(".//main:t", NS))
            if cell.attrib.get("t") == "s" and text:
                text = shared_strings[int(text)]
            values[address] = text or ""
        rows.append(values)
    return rows


def value_at(row, col):
    return row.get(f"{col}{row_number(row)}", "")


def row_number(row):
    for address in row:
        match = CELL.match(address)
        if match:
            return int(match.group(2))
    return 0


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/import-seat-workbook.py <seat-workbook.xlsx>")
    workbook = Path(sys.argv[1])
    with zipfile.ZipFile(workbook) as archive:
        workbook_xml = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships}
        shared_strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings_xml = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared_strings = [
                "".join(text.text or "" for text in item.findall(".//main:t", NS))
                for item in strings_xml.findall("main:si", NS)
            ]
        sheets = {}
        for sheet in workbook_xml.findall("main:sheets/main:sheet", NS):
            target = targets[sheet.attrib[f"{{{NS['rel']}}}id"]].lstrip("/")
            target = target if target.startswith("xl/") else f"xl/{target}"
            sheets[sheet.attrib["name"]] = sheet_rows(archive, target, shared_strings)

    layout_rows = sheets.get("Floor plan")
    assignment_rows = sheets.get("New Seat assignments")
    if not layout_rows or not assignment_rows:
        raise SystemExit("Expected 'Floor plan' and 'New Seat assignments' sheets.")

    positions = {}
    for row in layout_rows:
        for address, value in row.items():
            match = SEAT.match(value.strip())
            cell = CELL.match(address)
            if match and cell:
                positions[f"Z{match.group(1)}"] = {
                    "row": int(cell.group(2)),
                    "column": column_number(cell.group(1)),
                }

    teams = {}
    for row in assignment_rows:
        row_index = row_number(row)
        seat_range = row.get(f"A{row_index}", "").strip()
        team = row.get(f"B{row_index}", "").strip()
        match = RANGE.search(seat_range)
        if match and team:
            start, end = (int(match.group(1)), int(match.group(2)))
            for number in range(start, end + 1):
                teams[f"Z{number:03d}"] = team

    seats = []
    for number in range(1, 185):
        label = f"Z{number:03d}"
        position = positions.get(label, {})
        seats.append({
            "label": label,
            "team": teams.get(label, "Unassigned"),
            "row": position.get("row"),
            "column": position.get("column"),
        })

    output = Path("local-data/seat-inventory.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"seats": seats}, indent=2), encoding="utf-8")
    mapped = sum(seat["row"] is not None for seat in seats)
    print(f"Imported {len(seats)} seat IDs ({mapped} mapped to spreadsheet cells) to {output}.")
    print("Department labels and seat mappings remain in ignored local-data; review before sharing or deploying.")


if __name__ == "__main__":
    main()
