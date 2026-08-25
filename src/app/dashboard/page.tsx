import { redirect } from "next/navigation";

// The dashboard root has no content of its own — send people to Billing.
export default function DashboardIndex() {
  redirect("/dashboard/billing");
}
