import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { Icon, type IconName } from "./Icon";

/**
 * Widget de clima do rodapé da barra lateral, no mesmo estilo do app oficial
 * do Codex ("24°C · Pred. nublado"). Usa a API gratuita do Open-Meteo, sem
 * chave, e degrada graciosamente quando offline ou sem permissão de localização.
 */

interface WeatherState {
  readonly temperature: number;
  readonly condition: string;
  readonly icon: IconName;
}

const DEFAULT_LOCATION = { latitude: -23.5505, longitude: -46.6333 }; // São Paulo

function conditionForCode(code: number): { readonly label: string; readonly icon: IconName } {
  if (code === 0) {
    return { label: "Céu limpo", icon: "sun" };
  }
  if (code <= 2) {
    return { label: "Pred. nublado", icon: "cloudSun" };
  }
  if (code <= 3) {
    return { label: "Nublado", icon: "cloud" };
  }
  if (code <= 48) {
    return { label: "Nevoeiro", icon: "cloud" };
  }
  if (code <= 67) {
    return { label: "Chuva fraca", icon: "cloudRain" };
  }
  if (code <= 77) {
    return { label: "Neve", icon: "cloudRain" };
  }
  if (code <= 82) {
    return { label: "Pancadas de chuva", icon: "cloudRain" };
  }
  if (code <= 86) {
    return { label: "Nevascas", icon: "cloudRain" };
  }
  return { label: "Tempestade", icon: "cloudRain" };
}

async function fetchWeather(): Promise<WeatherState> {
  const position = await resolvePosition();
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${position.latitude}` +
    `&longitude=${position.longitude}` +
    "&current=temperature_2m,weather_code&timezone=auto";
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) {
    throw new Error(`weather request failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    readonly current?: { readonly temperature_2m?: number; readonly weather_code?: number };
  };
  const current = data.current;
  if (current?.temperature_2m === undefined || current.weather_code === undefined) {
    throw new Error("weather payload incomplete");
  }
  const condition = conditionForCode(current.weather_code);
  return {
    temperature: Math.round(current.temperature_2m),
    condition: condition.label,
    icon: condition.icon,
  };
}

function resolvePosition(): Promise<{ readonly latitude: number; readonly longitude: number }> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve(DEFAULT_LOCATION);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => resolve(DEFAULT_LOCATION),
      { maximumAge: 60_000, timeout: 4_000 },
    );
  });
}

export function WeatherWidget() {
  const [weather, setWeather] = createSignal<WeatherState | null>(null);
  const [failed, setFailed] = createSignal(false);

  onMount(() => {
    let cancelled = false;
    void fetchWeather()
      .then((state) => {
        if (!cancelled) {
          setWeather(state);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    onCleanup(() => {
      cancelled = true;
    });
  });

  return (
    <Show when={!failed() && weather()}>
      {(current) => (
        <span
          class="weather-widget"
          role="img"
          title={current().condition}
          aria-label={current().condition}
        >
          <span class="weather-widget-icon">
            <Icon name={current().icon} size={14} />
          </span>
          <strong>{current().temperature}°C</strong>
          <small>{current().condition}</small>
        </span>
      )}
    </Show>
  );
}
