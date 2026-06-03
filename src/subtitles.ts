// @ts-nocheck
export function parseSubtitles(text) {
    const subs = [];
    const cleanText = text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    const blocks = cleanText.split("\n\n");

    const timeRegex = /(\d{1,2})?:?(\d{2}):(\d{2})[,.](\d{3})/;

    function timeToMs(timeStr) {
        if (!timeStr) return 0;
        const match = timeStr.trim().match(timeRegex);
        if (!match) return 0;
        const hours = match[1] ? parseInt(match[1], 10) : 0;
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        const ms = parseInt(match[4], 10);
        return (hours * 3600 + minutes * 60 + seconds) * 1000 + ms;
    }

    for (const block of blocks) {
        const lines = block.trim().split("\n");
        const timeLineIndex = lines.findIndex((l) =>
            l.includes("-->"),
        );
        if (timeLineIndex !== -1) {
            const timeLine = lines[timeLineIndex];
            const [startStr, endStr] = timeLine.split("-->");
            const textLines = lines.slice(timeLineIndex + 1);

            const startMs = timeToMs(startStr);
            const endMs = timeToMs(endStr);
            const subText = textLines.join("<br>");

            if (subText) {
                subs.push({ startMs, endMs, text: subText });
            }
        }
    }
    return subs;
}
