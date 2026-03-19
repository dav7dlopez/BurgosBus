import "leaflet";

declare module "leaflet" {
  export function maplibreGL(options: {
    style: string;
    attribution?: string;
    pane?: string;
    interactive?: boolean;
  }): Layer;
}
