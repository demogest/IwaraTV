export type IssueAction = "settings" | "login" | "open-iwara" | "retry";

export interface UiIssue {
  title: string;
  detail: string;
  action: IssueAction;
  actionLabel: string;
}

export function classifyIssue(input: unknown): UiIssue {
  const detail = input instanceof Error ? input.message : String(input);
  const normalized = detail.toLowerCase();

  if (detail.includes("MPV") || normalized.includes("mpv")) {
    return {
      title: "MPV 未就绪",
      detail,
      action: "settings",
      actionLabel: "配置 MPV"
    };
  }

  if (detail.includes("外部播放器")) {
    return {
      title: "外部播放器未就绪",
      detail,
      action: "settings",
      actionLabel: "配置外部播放器"
    };
  }

  if (detail.includes("登录") || detail.includes("私有") || detail.includes("权限")) {
    return {
      title: "需要登录或授权",
      detail,
      action: "login",
      actionLabel: "去登录"
    };
  }

  if (detail.includes("浏览器验证") || normalized.includes("cloudflare")) {
    return {
      title: "需要站点验证",
      detail,
      action: "open-iwara",
      actionLabel: "应用内验证"
    };
  }

  return {
    title: "操作失败",
    detail,
    action: "retry",
    actionLabel: "重试"
  };
}
