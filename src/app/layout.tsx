import type { Metadata, Viewport } from "next";
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
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Autobuses Burgos",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#edf2f6" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('bus-burgos-theme');var theme=(t==='dark'||t==='light')?t:'light';document.documentElement.dataset.theme=theme;var c=theme==='dark'?'#000000':'#edf2f6';var m=document.querySelector('meta[name="theme-color"]');if(m){m.removeAttribute('media');m.setAttribute('content',c);} }catch(e){}})();`,
          }}
        />
      </head>
      <body
        className={`${appSans.variable} ${appDisplay.variable} ${geistMono.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
