# Bus Burgos Web

Aplicacion web para visualizar lineas, recorridos, paradas, vehiculos y tiempos de llegada del autobus urbano de Burgos mediante una API interna desacoplada.

## Stack

- Next.js 16 + React 19
- API interna en rutas `app/api`
- Leaflet para la interaccion del mapa
- OpenFreeMap como proveedor base del mapa
- Adaptador server-side hacia los recursos oficiales detectados en `movilidad.aytoburgos.es`

## Desarrollo

```bash
npm install
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000).

## API interna disponible

- `GET /api/lines`
- `GET /api/lines/:id`
- `GET /api/lines/:id/stops`
- `GET /api/lines/:id/shape`
- `GET /api/lines/:id/vehicles`
- `GET /api/stops/:id/arrivals`

## Fuente de datos

La aplicacion no expone al frontend los endpoints municipales. Toda llamada externa se hace server-side contra los recursos JSON detectados en el portlet oficial `IsaenextWebPortlet`.

## Mapa base

La vista de mapa usa Leaflet con una configuracion centralizada de proveedor en `src/lib/map-config.ts`. La opcion activa es OpenFreeMap y no requiere API key, registro ni facturacion.
