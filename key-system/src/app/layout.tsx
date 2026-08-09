import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KM Panel — Key System",
  description: "Key generation and access system",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
