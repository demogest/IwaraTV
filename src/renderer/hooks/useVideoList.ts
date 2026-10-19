import { useCallback, useEffect, useRef, useState } from "react";
import type { ListVideosRequest, VideoListResult } from "../../shared/types";
import { invoke } from "../lib/api";

const CACHE_LIMIT = 60;
const cache = new Map<string, VideoListResult>();

function remember(key: string, value: VideoListResult): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value!);
  }
}

export interface VideoListState {
  data?: VideoListResult;
  error?: unknown;
  loading: boolean;
  /** True while reloading data that is already shown. */
  refreshing: boolean;
  reload(): void;
}

/**
 * Loads a video list for `request`. Results are cached per request so going
 * back to a tab is instant; responses for outdated requests are ignored.
 * `cacheScope` should change when server-side filtering inputs change (e.g.
 * blocked tags).
 */
export function useVideoList(request: ListVideosRequest | undefined, cacheScope = ""): VideoListState {
  const key = request ? `${JSON.stringify(request)}|${cacheScope}` : undefined;
  const [state, setState] = useState<Omit<VideoListState, "reload">>(() => ({
    data: key ? cache.get(key) : undefined,
    loading: false,
    refreshing: false
  }));
  const sequence = useRef(0);
  const requestRef = useRef(request);
  requestRef.current = request;

  const load = useCallback(async (requestKey: string, keepData: boolean) => {
    const current = requestRef.current;
    if (!current) {
      return;
    }
    const id = ++sequence.current;
    setState((previous) => ({
      data: keepData ? previous.data : undefined,
      error: undefined,
      loading: !keepData,
      refreshing: keepData
    }));
    try {
      const data = await invoke("iwara:list-videos", current);
      remember(requestKey, data);
      if (id === sequence.current) {
        setState({ data, loading: false, refreshing: false });
      }
    } catch (error) {
      if (id === sequence.current) {
        setState((previous) => ({ data: keepData ? previous.data : undefined, error, loading: false, refreshing: false }));
      }
    }
  }, []);

  useEffect(() => {
    if (!key) {
      sequence.current += 1;
      setState({ loading: false, refreshing: false });
      return;
    }
    const cached = cache.get(key);
    if (cached) {
      sequence.current += 1;
      setState({ data: cached, loading: false, refreshing: false });
      return;
    }
    void load(key, false);
  }, [key, load]);

  const reload = useCallback(() => {
    if (key) {
      void load(key, Boolean(cache.get(key)));
    }
  }, [key, load]);

  return { ...state, reload };
}
