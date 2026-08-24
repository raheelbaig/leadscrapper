import { redirect } from "next/navigation";

/**
 * The product starts where the work starts.
 *
 * There is no dashboard to read before doing anything: the first screen is the
 * one that asks what businesses you need.
 */
export default function RootPage() {
  redirect("/generate");
}
