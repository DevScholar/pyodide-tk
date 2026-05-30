"""Check dylink NEEDED entries in an Emscripten wasm side module."""
import struct, sys

def read_varuint32(data, off):
    result = 0
    shift = 0
    while True:
        b = data[off]
        off += 1
        result |= (b & 0x7f) << shift
        if (b & 0x80) == 0:
            break
        shift += 7
    return result, off

def check(filepath):
    with open(filepath, "rb") as f:
        data = f.read()
    assert data[:4] == b"\x00asm", "Not a wasm file"
    pos = 8
    while pos < len(data):
        sec_id = data[pos]
        pos += 1
        size, pos = struct.unpack_from("<I", data, pos)[0], pos
        size = struct.unpack_from("<I", data, pos - 4)[0]
        if sec_id == 0:
            name_len, off = read_varuint32(data, pos)
            name = data[off:off+name_len].decode("utf-8", errors="replace")
            off += name_len
            payload = data[off:off+size-4-name_len]
            if name == "dylink":
                dylink_off = 0
                mem_size, dylink_off = read_varuint32(payload, dylink_off)
                mem_align, dylink_off = read_varuint32(payload, dylink_off)
                table_size, dylink_off = read_varuint32(payload, dylink_off)
                table_align, dylink_off = read_varuint32(payload, dylink_off)
                ndeps, dylink_off = read_varuint32(payload, dylink_off)
                print(f"{filepath}: {ndeps} NEEDED entries")
                for i in range(ndeps):
                    dep_len, dylink_off = read_varuint32(payload, dylink_off)
                    dep = payload[dylink_off:dylink_off+dep_len]
                    dylink_off += dep_len
                    print(f"  NEEDED: {dep}")
                return
        pos += size

if __name__ == "__main__":
    for f in sys.argv[1:]:
        check(f)
