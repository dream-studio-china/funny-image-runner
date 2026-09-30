import AdminDashboard from "@/components/admin-dashboard";

export const metadata = {
  title: "管理后台 · 咔嚓造梦局",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminDashboard />;
}
