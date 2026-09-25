import type { Metadata } from "next";
import { Sidebar } from "@/components/Sidebar";
import { WorkspaceProvider } from "@/components/Workspace";
import "./globals.css";

export const metadata: Metadata = {
  title: "wcbetter",
  description: "Turn a WarcraftLogs report into a prioritised improvement plan.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WorkspaceProvider>
          <div className="shell">
            <Sidebar />
            <main className="content">{children}</main>
          </div>
        </WorkspaceProvider>
      </body>
    </html>
  );
}
