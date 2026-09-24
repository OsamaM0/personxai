import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalMediaUrl,
  isDownloadableUrl,
  probeContentLength,
  resolveMediaDownload,
  safeFileName,
  youTubeId,
} from "../../src/services/media/download";
import { selectTopics } from "../../src/tools/topics";

const API = { baseUrl: "https://cobalt.example" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubJson(body: unknown, init: { status?: number } = {}) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, requestInit: RequestInit) => {
    calls.push({
      url: String(url),
      body: requestInit?.body ? JSON.parse(String(requestInit.body)) : null,
    });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

describe("youTubeId", () => {
  it("reads every shape a link is pasted in", () => {
    expect(youTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeId("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe("dQw4w9WgXcQ");
    expect(youTubeId("https://m.youtube.com/shorts/abc123XYZ_-")).toBe("abc123XYZ_-");
    expect(youTubeId("https://music.youtube.com/watch?v=abc123XYZ&list=RD")).toBe("abc123XYZ");
  });

  it("is null for everything else", () => {
    expect(youTubeId("https://vimeo.com/12345")).toBeNull();
    expect(youTubeId("https://www.youtube.com/@channel")).toBeNull();
    expect(youTubeId("not a url")).toBeNull();
  });
});

describe("url handling", () => {
  it("canonicalizes YouTube links and leaves others alone", () => {
    expect(canonicalMediaUrl("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    expect(canonicalMediaUrl(" https://vimeo.com/12345 ")).toBe("https://vimeo.com/12345");
  });

  it("only accepts http(s)", () => {
    expect(isDownloadableUrl("https://a.example/v")).toBe(true);
    expect(isDownloadableUrl("file:///etc/passwd")).toBe(false);
    expect(isDownloadableUrl("data:text/plain,hi")).toBe(false);
  });

  it("strips path characters out of a filename the API chose", () => {
    expect(safeFileName("../../etc/passwd", "video.mp4")).toBe("....etcpasswd");
    expect(safeFileName("", "video.mp4")).toBe("video.mp4");
    expect(safeFileName(undefined, "audio.mp3")).toBe("audio.mp3");
  });
});

describe("resolveMediaDownload", () => {
  it("asks for audio when audioOnly is set, and returns the tunnel URL", async () => {
    const calls = stubJson({ status: "tunnel", url: "https://cdn.example/f.mp3", filename: "song.mp3" });
    const result = await resolveMediaDownload(API, "https://youtu.be/dQw4w9WgXcQ", {
      audioOnly: true,
    });

    expect(calls[0]?.url).toBe("https://cobalt.example/");
    expect(calls[0]?.body).toMatchObject({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      downloadMode: "audio",
    });
    expect(result).toEqual({ url: "https://cdn.example/f.mp3", fileName: "song.mp3", kind: "audio" });
  });

  it("understands the older stream/redirect statuses", async () => {
    stubJson({ status: "stream", url: "https://cdn.example/v.mp4" });
    expect(await resolveMediaDownload(API, "https://vimeo.com/1")).toEqual({
      url: "https://cdn.example/v.mp4",
      fileName: "video.mp4",
      kind: "video",
    });
  });

  it("takes the first item of a picker and says how many were left", async () => {
    stubJson({
      status: "picker",
      picker: [
        { type: "photo", url: "https://cdn.example/1.jpg" },
        { type: "photo", url: "https://cdn.example/2.jpg" },
      ],
    });
    expect(await resolveMediaDownload(API, "https://x.com/i/status/1")).toEqual({
      url: "https://cdn.example/1.jpg",
      fileName: "photo.jpg",
      kind: "photo",
      alternatives: 1,
    });
  });

  it("turns a cobalt error code into something sayable", async () => {
    stubJson({ status: "error", error: { code: "error.api.content.video.private" } });
    expect(await resolveMediaDownload(API, "https://youtu.be/dQw4w9WgXcQ")).toEqual({
      error: "private",
    });
  });

  it("never throws when the instance is down", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await resolveMediaDownload(API, "https://youtu.be/dQw4w9WgXcQ")).toEqual({
      error: "could not reach the download service",
    });
  });

  it("rejects a non-http link before calling out", async () => {
    const calls = stubJson({ status: "tunnel", url: "https://cdn.example/f" });
    expect(await resolveMediaDownload(API, "file:///etc/passwd")).toEqual({
      error: "that is not an http(s) link",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("probeContentLength", () => {
  it("returns the declared size, and null when there is none", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(null, { status: 200, headers: { "content-length": "1048576" } })
    );
    expect(await probeContentLength("https://cdn.example/f.mp4")).toBe(1048576);

    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    expect(await probeContentLength("https://cdn.example/f.mp4")).toBeNull();
  });

  it("treats a failed probe as unknown rather than as an error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("timeout");
    });
    expect(await probeContentLength("https://cdn.example/f.mp4")).toBeNull();
  });
});

describe("selectTopics for downloads", () => {
  it("picks up download requests in both languages", () => {
    expect(selectTopics("download this https://youtu.be/dQw4w9WgXcQ")).toContain("media");
    expect(selectTopics("نزل الفيديو ده")).toContain("media");
    expect(selectTopics("عايز الأغنية دي mp3")).toContain("media");
  });

  it("does not fire on ordinary words that merely contain them", () => {
    expect(selectTopics("log my freelance income")).not.toContain("media");
    expect(selectTopics("tracking the budget")).not.toContain("media");
  });
});
