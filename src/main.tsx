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

function renderBootstrapFailure(mountElement: HTMLElement, reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason);
  const panel = document.createElement("main");
  panel.className = "bootstrap-failure";
  const title = document.createElement("h1");
  title.textContent = "Não foi possível iniciar o Codex App";
  const description = document.createElement("p");
  description.textContent = message;
  panel.append(title, description);
  mountElement.replaceChildren(panel);
}

void bootstrap(root).catch((reason: unknown) => {
  renderBootstrapFailure(root, reason);
});
