// @ts-nocheck
const YIELD_EVERY_N_FRAMES = 40;

function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// Decodes in chunks with a yield back to the main thread every N frames so a
// large BIF index doesn't freeze the UI while it decodes.
export async function decodeBif(buffer, onProgress) {
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

        if (i % YIELD_EVERY_N_FRAMES === 0) {
            if (onProgress) onProgress(i / count);
            await yieldToMain();
        }
    }
    if (onProgress) onProgress(1);
    return frames;
}
