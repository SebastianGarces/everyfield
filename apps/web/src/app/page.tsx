import { homeHTML } from "@/marketing/markup";
import { Site } from "@/marketing/Site";

export default function Home() {
  return <Site path="/" html={homeHTML()} />;
}
