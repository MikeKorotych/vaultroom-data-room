import { Show, SignInButton } from "@clerk/nextjs";
import { ShieldCheck } from "lucide-react";
import { DataRoomApp } from "@/components/data-room-app";

export default function Home() {
  return (
    <>
      <Show when="signed-out">
        <main className="signInPage">
          <div className="signInMark"><ShieldCheck /> VAULTROOM / 01</div>
          <section>
            <p className="eyebrow">PRIVATE DUE DILIGENCE</p>
            <h1>Order creates<br />confidence.</h1>
            <p>Secure document exchange for teams making consequential decisions.</p>
            <SignInButton mode="modal"><button>Enter secure room</button></SignInButton>
          </section>
          <footer>256-bit encryption · access logging · revocable sharing</footer>
        </main>
      </Show>
      <Show when="signed-in"><DataRoomApp /></Show>
    </>
  );
}
