"""Read an OpenAPI schema on stdin, write it back on stdout with unique operationIds.

TiTiler's `cog` and `mosaic` factories register routes with identical operation_ids
(getWMTS, getTile, ...). Generated TS clients can't have duplicate identifiers, so
we prefix the 2nd+ occurrence of any operationId with its first tag.
"""

import json
import sys


def dedupe(schema):
    seen = {}
    for methods in schema.get("paths", {}).values():
        for op in methods.values():
            if not isinstance(op, dict):
                continue
            op_id = op.get("operationId")
            if not op_id:
                continue
            if op_id in seen:
                tag = (op.get("tags") or ["default"])[0]
                op["operationId"] = tag + "_" + op_id
            seen[op_id] = seen.get(op_id, 0) + 1
    return schema


if __name__ == "__main__":
    schema = json.load(sys.stdin)
    json.dump(dedupe(schema), sys.stdout)
