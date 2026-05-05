import { describe, expect, it } from "vitest";
import { buildExternalPlayerArgs, splitTemplateArgs } from "../src/shared/player-utils";

describe("player template utilities", () => {
  it("splits quoted command templates", () => {
    expect(splitTemplateArgs("--play \"{url}\" --title '{title}'")).toEqual(["--play", "{url}", "--title", "{title}"]);
  });

  it("expands external player templates", () => {
    expect(
      buildExternalPlayerArgs("--url \"{url}\" --name \"{title}\" --headers \"{headers}\"", {
        url: "https://media.example/video.mp4",
        title: "Demo Title",
        headers: "Referer: https://www.iwara.tv/"
      })
    ).toEqual([
      "--url",
      "https://media.example/video.mp4",
      "--name",
      "Demo Title",
      "--headers",
      "Referer: https://www.iwara.tv/"
    ]);
  });
});

