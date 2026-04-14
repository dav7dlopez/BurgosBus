import type { Metadata } from "next";
import { Geist_Mono, Manrope, Sora } from "next/font/google";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

const appSans = Manrope({
  variable: "--font-app-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const appDisplay = Sora({
  variable: "--font-app-display",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Autobuses Burgos",
  description: "Visualizacion en tiempo real de autobuses urbanos de Burgos",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${appSans.variable} ${appDisplay.variable} ${geistMono.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
