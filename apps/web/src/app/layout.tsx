import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "@fontsource-variable/manrope";
import "@fontsource-variable/newsreader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vaultroom · Secure due diligence",
  description: "A secure data room for confidential document review.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en"><body>{children}</body></html>
    </ClerkProvider>
  );
}
