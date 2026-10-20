import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LanguagePreference, ThemePreference } from "../shared/types";
import { App } from "./App";
import { I18nProvider, resolveLocale, type Locale } from "./i18n";
import { AppStateProvider } from "./state/app-state";
import { ConfirmProvider } from "./state/confirm";
import { NavigationProvider } from "./state/navigation";
import { ToastProvider } from "./state/toasts";
import { UpdatesProvider } from "./state/updates";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/views.css";

const LOCALE_KEY = "iwaratv.locale";

function cachedLocale(): Locale | undefined {
  try {
    const value = localStorage.getItem(LOCALE_KEY);
    return value === "zh-CN" || value === "en" ? value : undefined;
  } catch {
    return undefined;
  }
}

function useTheme(preference: ThemePreference): void {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = preference === "system" ? query.matches : preference === "dark";
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [preference]);
}

function Root() {
  const [language, setLanguage] = useState<LanguagePreference>();
  const [theme, setTheme] = useState<ThemePreference>("system");
  const locale = language ? resolveLocale(language) : cachedLocale() ?? resolveLocale("system");
  useTheme(theme);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      // Only used to avoid a language flash on the next launch.
    }
  }, [locale]);

  return (
    <I18nProvider locale={locale}>
      <ToastProvider>
        <ConfirmProvider>
          <NavigationProvider>
            <AppStateProvider
              onUiChange={(ui) => {
                setLanguage(ui.language);
                setTheme(ui.theme);
              }}
            >
              <UpdatesProvider>
                <App />
              </UpdatesProvider>
            </AppStateProvider>
          </NavigationProvider>
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

async function start(): Promise<void> {
  // Browser-only preview (`npm run dev:web`): serve fake data instead of the desktop backend.
  if (import.meta.env.DEV && !window.iwaraTV) {
    const { installMockBridge } = await import("./dev/mock-bridge");
    installMockBridge();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root />
    </StrictMode>
  );
}

void start();
