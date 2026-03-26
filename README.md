# Bus Burgos Web

Aplicacion web para visualizar lineas, recorridos, paradas, vehiculos y tiempos de llegada del autobus urbano de Burgos mediante una API interna desacoplada del frontend.

El proyecto esta construido con Next.js y React, y encapsula en rutas internas la integracion con las fuentes municipales para evitar exponer directamente esos endpoints al navegador.

## A. Descripcion Del Proyecto

La aplicacion muestra informacion del autobus urbano de Burgos sobre un mapa interactivo e incorpora una capa de servidor propia para consultar, normalizar y servir datos de:

- lineas disponibles;
- recorridos y paradas por linea;
- vehiculos en tiempo real;
- estimaciones de llegada a parada;
- paradas cercanas a la ubicacion del usuario.

La integracion externa se realiza en el servidor mediante un adaptador propio hacia recursos detectados en `movilidad.aytoburgos.es`.

## B. Funcionalidades Principales

- Visualizacion de lineas de autobus disponibles.
- Consulta del detalle de una linea con sus rutas y paradas.
- Visualizacion de recorridos sobre mapa.
- Visualizacion de vehiculos activos por linea.
- Consulta de llegadas estimadas a una parada.
- Deteccion de paradas cercanas a la ubicacion del usuario.
- Cambio de tema claro/oscuro.
- API interna bajo `src/app/api` para desacoplar el frontend del upstream municipal.

## C. Stack Tecnologico

- Next.js 16
- React 19
- TypeScript
- App Router de Next.js
- ESLint 9 con `eslint-config-next`
- Leaflet
- React Leaflet
- MapLibre GL
- `@maplibre/maplibre-gl-leaflet`
- `next/font/google` para carga de fuentes

## D. Estructura Del Proyecto

```text
src/
  app/
    api/
      lines/
      stops/
    globals.css
    layout.tsx
    page.tsx
  components/
    bus-map.tsx
    transit-dashboard.tsx
  lib/
    burgos-provider.ts
    cache.ts
    http.ts
    map-config.ts
    types.ts
  types/
    maplibre-leaflet.d.ts
public/
```

### Modulos Principales

- `src/app/page.tsx`: punto de entrada de la aplicacion.
- `src/components/transit-dashboard.tsx`: contenedor principal de la UI, estado cliente, polling, geolocalizacion y coordinacion de paneles.
- `src/components/bus-map.tsx`: renderizado del mapa, recorridos, paradas, vehiculos y ubicacion del usuario.
- `src/lib/burgos-provider.ts`: adaptador server-side hacia la fuente de datos municipal; normaliza lineas, rutas, paradas, vehiculos y llegadas.
- `src/lib/cache.ts`: cache en memoria con TTL para reducir llamadas repetidas al upstream.
- `src/lib/http.ts`: manejo basico de errores para las rutas API.
- `src/lib/map-config.ts`: configuracion centralizada del proveedor base del mapa.
- `src/lib/types.ts`: contratos y tipos de dominio usados en frontend y backend.

## E. Puesta En Marcha En Local

### Requisitos

- Node.js: `TODO` definir version minima recomendada en el repositorio.
- npm

### Instalacion

```bash
npm install
```

### Desarrollo

```bash
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000).

### Notas

- La aplicacion consulta datos externos en tiempo real, por lo que necesita acceso de red al upstream municipal y al proveedor de mapas.
- La geolocalizacion del navegador requiere contexto seguro. En local puede depender del navegador y su configuracion.

## F. Scripts Disponibles

Definidos actualmente en `package.json`:

- `npm run dev`: inicia el servidor de desarrollo con Next.js.
- `npm run build`: genera la build de produccion.
- `npm run start`: arranca la aplicacion en modo produccion sobre la build generada.
- `npm run lint`: ejecuta ESLint.

### Validacion Actual

Hoy el proyecto no expone scripts de test automatizado en `package.json`.

`TODO`: incorporar una estrategia minima de validacion automatizada para profesionalizar el proyecto.

## G. API Interna / Rutas Principales

La API interna actual expone estas rutas:

- `GET /api/lines`
- `GET /api/lines/:id`
- `GET /api/lines/:id/stops`
- `GET /api/lines/:id/shape`
- `GET /api/lines/:id/vehicles`
- `GET /api/stops/:id/arrivals`
- `GET /api/stops/nearby?lat={lat}&lng={lng}&radius={metros}`

### Rol De La API Interna

- Centraliza la integracion externa en el servidor.
- Normaliza respuestas para el frontend.
- Aplica cache en memoria con TTL segun el tipo de dato.
- Evita exponer directamente al cliente la logica de acceso a los recursos municipales.

## H. Fuente De Datos Externa E Integracion

### Upstream Municipal

La fuente externa detectada es:

- `https://movilidad.aytoburgos.es`

La integracion principal esta centralizada en `src/lib/burgos-provider.ts` y utiliza:

- la pagina `/rutas-en-directo` para obtener lineas disponibles;
- recursos asociados al portlet `IsaenextWebPortlet`;
- consultas server-side para nodos, rutas, vehiculos y estimaciones.

### Proveedor De Mapa

La vista de mapa usa Leaflet con configuracion centralizada en `src/lib/map-config.ts`.

La opcion activa por defecto es OpenFreeMap y no requiere API key, registro ni facturacion segun la configuracion actual del proyecto.

### Importante

- No se ha detectado contrato formal ni documentacion versionada del upstream municipal dentro del repositorio.
- Si el HTML o los recursos externos cambian, la aplicacion puede dejar de funcionar parcial o totalmente.

## I. Configuracion Y Variables De Entorno

No se han detectado variables de entorno consumidas desde el codigo (`process.env` o `NEXT_PUBLIC_*`).

No existe actualmente un archivo `.env.example`.

Esto sugiere que:

- el proyecto puede arrancar sin configuracion local adicional;
- las URLs externas relevantes estan embebidas en codigo;
- cualquier futura parametrizacion todavia no esta formalizada.

`TODO`: si se quiere profesionalizar el proyecto, valorar mover a configuracion externa al menos:

- URLs de proveedores externos;
- opciones de cache;
- posibles flags de entorno.

## J. Build Y Despliegue

### Build

```bash
npm run build
```

### Ejecucion En Produccion

```bash
npm run start
```

### Despliegue

No se han encontrado en este repositorio:

- `Dockerfile`
- `docker-compose`
- configuracion de Vercel
- configuracion de Netlify
- pipelines CI/CD

Por tanto:

- la build de produccion esta clara;
- la estrategia de despliegue real no puede deducirse con seguridad solo a partir del repositorio.

`TODO`: documentar entorno objetivo de despliegue, version de Node y flujo de release.

## K. Limitaciones O Problemas Conocidos

- Dependencia fuerte de servicios externos municipales.
- Obtencion de lineas basada en parseo HTML, lo que puede ser fragil ante cambios del upstream.
- Cache en memoria local al proceso; no hay evidencia de cache distribuida.
- No hay tests automatizados en el repositorio.
- No hay observabilidad ni logging estructurado documentado.
- No hay documentacion de despliegue.
- No hay version minima de Node documentada.
- `public/` aun contiene varios assets por defecto de la plantilla de Next.js que no parecen formar parte del producto final.

## L. Proximos Pasos O Mejoras Recomendadas

- Documentar la arquitectura y el flujo de datos con mas detalle.
- Añadir requisitos de entorno y version minima de Node.
- Incorporar `.env.example` cuando exista configuracion parametrizable.
- Añadir tests unitarios e integracion minima sobre el adaptador server-side y las rutas API.
- Definir pipeline de validacion automatica (`lint`, `build`, `test`).
- Documentar estrategia de despliegue.
- Revisar y limpiar artefactos o restos de plantilla no necesarios.
- Añadir una guia de colaboracion para mantenimiento y trabajo asistido con Codex.

## Estado De Documentacion

Este README describe lo que puede inferirse con seguridad del repositorio actual.

Cuando una parte no esta confirmada por el codigo o la configuracion existente, se marca como `TODO` en lugar de asumirla.
