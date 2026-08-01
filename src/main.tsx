import { render } from "solid-js/web";

import "./styles/global.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Application root was not found");
}

const previewRequested = new URLSearchParams(window.location.search).get("preview") === "1";

async function bootstrap(mountElement: HTMLElement): Promise<void> {
  if (previewRequested) {
    if (!import.meta.env.DEV) {
      throw new Error("A visualização no navegador só está disponível em desenvolvimento.");
    }
    const { setupBrowserPreview } = await import("./preview/setupBrowserPreview");
    setupBrowserPreview();
  }

  const { default: App } = await import("./App");
  render(() => <App />, mountElement);
}

void bootstrap(root);
