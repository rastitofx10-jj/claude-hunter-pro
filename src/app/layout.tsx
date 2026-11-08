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
  title: "Claude Hunter — צייד פרויקטי Claude ב-GitHub",
  description:
    "כלי חזק לחיפוש, איתור וניתוח פרויקטים שנבנו עם Claude בתשלום: זיהוי מודלים פרימיום בסף מחמיר 5.5+ בלבד (Opus 5.5, Fable, Opus 6+ — 4.x חסום), מדד השקעה בטוקנים, וניתוח מעמיק של מאגרים.",
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
    <html lang="he" dir="rtl" suppressHydrationWarning>
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
