#!/usr/bin/env python3
"""Regenerate lib/schema.json from a compiled FileDescriptorSet.

kagent 1.0 serves its API as gRPC / gRPC-Web only (no REST, no JSON
transcoding on the controller), so Scope carries a compact message schema and
lib/grpcweb.mjs encodes/decodes against it. The schema comes from the release's
own .proto files, compiled into a FileDescriptorSet:

  # from a kagent checkout at the release tag (proto/ holds kagent + ateapi + a2a)
  buf build proto -o rc3.desc            # or:
  python3 -m grpc_tools.protoc -I proto -I <deps> --include_imports \\
      --descriptor_set_out=rc3.desc \\
      kagent/api/v1/system.proto kagent/api/v1/sessions.proto \\
      kagent/api/v1/agents.proto api/ateapi/v1/ateapi.proto a2a.proto

  python3 tools/gen-schema.py rc3.desc > lib/schema.json

<deps> holds buf/validate/validate.proto and google/api/{annotations,http}.proto.
The checked-in schema is from kagent v1.0.0-rc3 (rc2 differs only by
DeleteSessionRequest.force).

Needs `pip install protobuf`. Only these packages are kept:
kagent.api.v1, substrate.ateapi.v1, lf.a2a.v1, google.*
"""
import json
import sys

from google.protobuf import descriptor_pb2 as d

KEEP = ('kagent.api.v1', 'substrate.ateapi.v1', 'lf.a2a.v1', 'google.')
SCALAR = {v: k[5:].lower() for k, v in d.FieldDescriptorProto.Type.items()}  # TYPE_STRING -> string


def keep(pkg):
    return any(pkg == k or pkg.startswith(k if k.endswith('.') else k + '.') for k in KEEP)


def compile_files(files):
    msgs, enums, methods = {}, {}, {}

    def walk(prefix, m):
        full = f'{prefix}.{m.name}'
        for n in m.nested_type:
            walk(full, n)
        for e in m.enum_type:
            enums[f'{full}.{e.name}'] = {v.number: v.name for v in e.value}
        fields = {f.number: [f.name, SCALAR[f.type], f.label == d.FieldDescriptorProto.LABEL_REPEATED,
                             f.type_name.lstrip('.') or None] for f in m.field}
        msgs[full] = {'f': fields, **({'map': 1} if m.options.map_entry else {})}

    for fd in files:
        if not keep(fd.package):
            continue
        for m in fd.message_type:
            walk(fd.package, m)
        for e in fd.enum_type:
            enums[f'{fd.package}.{e.name}'] = {v.number: v.name for v in e.value}
        for s in fd.service:
            for mm in s.method:
                methods[f'{fd.package}.{s.name}/{mm.name}'] = [mm.input_type.lstrip('.'), mm.output_type.lstrip('.')]
    return {'messages': msgs, 'enums': enums, 'methods': methods}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: gen-schema.py <FileDescriptorSet.desc> > lib/schema.json')
    fds = d.FileDescriptorSet()
    with open(sys.argv[1], 'rb') as fh:
        fds.ParseFromString(fh.read())
    out = compile_files(fds.file)
    if not any(m.startswith('kagent.api.v1.SystemService/') for m in out['methods']):
        sys.exit('descriptor set has no kagent.api.v1.SystemService — wrong input?')
    json.dump(out, sys.stdout, separators=(',', ':'), sort_keys=True)
    sys.stdout.write('\n')
