import { describe, expect, it } from "vitest";
import { classifyIssue } from "../src/renderer/issue-utils";

describe("issue classification", () => {
  it("routes player setup errors to settings", () => {
    expect(classifyIssue("未找到 MPV。").action).toBe("settings");
    expect(classifyIssue("外部播放器路径不存在。").actionLabel).toBe("配置外部播放器");
  });

  it("routes auth and browser verification errors", () => {
    expect(classifyIssue("这是私有视频，需要登录。").action).toBe("login");
    const cloudflare = classifyIssue("Cloudflare browser challenge");
    expect(cloudflare.action).toBe("open-iwara");
    expect(cloudflare.actionLabel).toBe("应用内验证");
  });
});
