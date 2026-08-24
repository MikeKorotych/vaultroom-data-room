import { SharedRoomView } from "@/components/shared-room-view";

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedRoomView token={token} />;
}
