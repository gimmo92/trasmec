"use client";

import { useState } from "react";
import AccountBar from "@/components/AccountBar";
import Archivio from "@/components/Archivio";
import GestioneOfferte from "@/components/GestioneOfferte";
import IndiciRicambi from "@/components/IndiciRicambi";
import IstruzioniPersonalizzate from "@/components/IstruzioniPersonalizzate";
import OfferteV2 from "@/components/OfferteV2";
import SigleSpareParts from "@/components/SigleSpareParts";

type Tab = "archivio" | "offerte" | "offerte-v2" | "indici" | "sigle" | "istruzioni";

export default function Home() {
  const [tab, setTab] = useState<Tab>("archivio");

  return (
    <div className="shell">
      <nav className="topnav">
        <div className="brand">
          <div className="logo">T</div>
          <h1>Trasmec</h1>
        </div>
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "archivio"}
            className={tab === "archivio" ? "tab on" : "tab"}
            onClick={() => setTab("archivio")}
          >
            Archivio
          </button>
          <button
            role="tab"
            aria-selected={tab === "offerte"}
            className={tab === "offerte" ? "tab on" : "tab"}
            onClick={() => setTab("offerte")}
          >
            Offerta lista impianto
          </button>
          <button
            role="tab"
            aria-selected={tab === "offerte-v2"}
            className={tab === "offerte-v2" ? "tab on" : "tab"}
            onClick={() => setTab("offerte-v2")}
          >
            Offerta richiesta cliente
          </button>
          <button
            role="tab"
            aria-selected={tab === "indici"}
            className={tab === "indici" ? "tab on" : "tab"}
            onClick={() => setTab("indici")}
          >
            Indici dei ricambi
          </button>
          <button
            role="tab"
            aria-selected={tab === "sigle"}
            className={tab === "sigle" ? "tab on" : "tab"}
            onClick={() => setTab("sigle")}
          >
            Sigle spare parts
          </button>
          <button
            role="tab"
            aria-selected={tab === "istruzioni"}
            className={tab === "istruzioni" ? "tab on" : "tab"}
            onClick={() => setTab("istruzioni")}
          >
            Personalizza istruzioni
          </button>
        </div>
        <AccountBar />
      </nav>
      <section
        role="tabpanel"
        hidden={tab !== "archivio"}
        className="tab-panel"
      >
        <Archivio />
      </section>
      <section
        role="tabpanel"
        hidden={tab !== "offerte"}
        className="tab-panel"
      >
        <GestioneOfferte active={tab === "offerte"} />
      </section>
      <section
        role="tabpanel"
        hidden={tab !== "offerte-v2"}
        className="tab-panel"
      >
        <OfferteV2 />
      </section>
      <section
        role="tabpanel"
        hidden={tab !== "indici"}
        className="tab-panel"
      >
        <IndiciRicambi />
      </section>
      <section
        role="tabpanel"
        hidden={tab !== "sigle"}
        className="tab-panel"
      >
        <SigleSpareParts />
      </section>
      <section
        role="tabpanel"
        hidden={tab !== "istruzioni"}
        className="tab-panel"
      >
        <IstruzioniPersonalizzate />
      </section>
    </div>
  );
}
