use crate::error::{message, AppResult};

pub struct PlayerTemplateValues<'a> {
    pub url: &'a str,
    pub title: &'a str,
    pub headers: &'a str,
}

pub fn split_template_args(template: &str) -> AppResult<Vec<String>> {
    let input = if template.trim().is_empty() {
        "{url}"
    } else {
        template.trim()
    };
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }

    if quote.is_some() {
        return Err(message("外部播放器参数模板存在未闭合的引号。"));
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        args.push(current);
    }

    Ok(args)
}

pub fn build_external_player_args(template: &str, values: &PlayerTemplateValues<'_>) -> AppResult<Vec<String>> {
    split_template_args(template).map(|args| {
        args.into_iter()
            .map(|arg| {
                arg.replace("{url}", values.url)
                    .replace("{title}", values.title)
                    .replace("{headers}", values.headers)
            })
            .collect()
    })
}

pub fn template_includes_url(template: &str) -> AppResult<bool> {
    Ok(split_template_args(template)?.iter().any(|arg| arg.contains("{url}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_expands_templates() {
        let args = split_template_args(r#"--play "{url}" --title '{title}'"#).unwrap();
        assert_eq!(args, vec!["--play", "{url}", "--title", "{title}"]);
        let expanded = build_external_player_args(
            r#"--url "{url}" --name "{title}" --headers "{headers}""#,
            &PlayerTemplateValues {
                url: "https://media.example/video.mp4",
                title: "Demo Title",
                headers: "Referer: https://www.iwara.tv/",
            },
        )
        .unwrap();
        assert_eq!(
            expanded,
            vec![
                "--url",
                "https://media.example/video.mp4",
                "--name",
                "Demo Title",
                "--headers",
                "Referer: https://www.iwara.tv/"
            ]
        );
        assert!(template_includes_url("--play {url}").unwrap());
        assert!(!template_includes_url("--empty").unwrap());
    }
}
