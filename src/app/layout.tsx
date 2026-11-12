import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "@/components/hunter/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Claude Hunter — Hunt premium-Claude projects on GitHub",
  description:
    "Find, track, and analyze GitHub projects built with paid Claude: real-model truth detection (Opus 4.5 = the strongest that exists, fictional strings flagged), a token investment score, and deep repo analysis.",
  keywords: ["Claude", "GitHub", "Anthropic", "Opus", "Claude Code", "AI projects", "investment score"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            {children}
          </ThemeProvider>
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
