// @ts-nocheck
export function decodeBif(buffer) {
    const view = new DataView(buffer);
    const count = view.getUint32(12, true);
    const frames = [];
    let offset = 64;

    for (let i = 0; i < count; i++) {
        const ts = view.getUint32(offset, true) * 1000;
        const start = view.getUint32(offset + 4, true);
        const end =
            i === count - 1
                ? buffer.byteLength
                : view.getUint32(offset + 12, true);
        const segment = buffer.slice(start, end);
        const rawBlobData = new Blob([segment], {
            type: "image/jpeg",
        });
        const url = URL.createObjectURL(rawBlobData);
        frames.push({ timestampMs: ts, url, rawBlobData });
        offset += 8;
    }
    return frames;
}
