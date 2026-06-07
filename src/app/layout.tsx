import type { Metadata } from 'next';
import { Barlow_Condensed, Inter } from 'next/font/google';
import Script from 'next/script';
import './globals.css';

const display = Barlow_Condensed({
  subsets: ['latin'],
  variable: '--font-display-google',
  weight: ['400', '500', '600', '700'],
});

const body = Inter({
  subsets: ['latin'],
  variable: '--font-body-google',
});

export const metadata: Metadata = {
  title: 'CrewAI Studio Local',
  description: 'Standalone local UI for building and managing CrewAI agents and crews',
};

// Inlined and runs `beforeInteractive` so we set the theme attributes
// before the first paint — otherwise users would briefly see the
// default Midnight theme flash when they have a different theme
// selected. Migrates the legacy 'dark'/'light' key on the fly so users
// from before this change don't lose their preference.
const themeScript = `
  try {
    var darkSlugs = ['midnight','tokyo-night','dracula','github-dark'];
    var lightSlugs = ['github-light','solarized-light','one-light'];
    var key = 'crewai-studio-theme-id';
    var legacyKey = 'crewai-studio-theme';
    var raw = localStorage.getItem(key);
    if (!raw) {
      var legacy = localStorage.getItem(legacyKey);
      if (legacy === 'light') { raw = 'github-light'; localStorage.setItem(key, raw); }
      else if (legacy === 'dark') { raw = 'midnight'; localStorage.setItem(key, raw); }
    }
    if (darkSlugs.indexOf(raw) === -1 && lightSlugs.indexOf(raw) === -1) raw = 'midnight';
    document.documentElement.dataset.themeId = raw;
    document.documentElement.dataset.themeMode = lightSlugs.indexOf(raw) >= 0 ? 'light' : 'dark';
  } catch (error) {
    document.documentElement.dataset.themeId = 'midnight';
    document.documentElement.dataset.themeMode = 'dark';
  }
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme-id="midnight"
      data-theme-mode="dark"
      suppressHydrationWarning
      className={`${display.variable} ${body.variable} h-full antialiased`}
    >
      <body className="h-full">
        <Script id="crewai-studio-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        {children}
      </body>
    </html>
  );
}
