export default function Funzionamento() {
  return (
    <div className="rules-page">
      <header className="rules-head">
        <h2>Funzionamento</h2>
        <p>
          Regole con cui si costruisce l&apos;offerta lista impianto. La bozza
          nasce da offerta, distinte, indici, sigle e listino. Claude riscrive
          solo le descrizioni: non aggiunge, non toglie e non riordina le righe,
          e non cambia codici né quantità.
        </p>
      </header>

      <section>
        <h3>1. Quali macchine entrano</h3>
        <ul>
          <li>Si legge il PDF dell&apos;offerta. Entrano solo gli item dopo la riga AFTER SALES.</li>
          <li>Per ogni codice (BF0509, BF0514, …) serve la distinta caricata in Archivio.</li>
          <li>Le spunte sull&apos;elenco limitano l&apos;analisi alle distinte scelte.</li>
          <li>
            La posizione del COC, per esempio POS. 14.055, va accanto al codice
            macchina nella colonna Project e nel titolo della macchina.
          </li>
        </ul>
      </section>

      <section>
        <h3>2. Come si legge la distinta</h3>
        <ul>
          <li>
            <strong>Parts only</strong> o <strong>Structured</strong>: tabella con
            part number. Qui vale il filtro delle sigle.
          </li>
          <li>
            <strong>Foglio 1</strong> (configurazione TK/TKK): non c&apos;è la
            tabella part number. Si leggono le sezioni etichettate. Il filtro
            sigle non si applica.
          </li>
          <li>
            <strong>Coclea</strong>, foglio SPARE PARTS: solo le righe con flag S
            e quantità installata maggiore di zero. Anche qui il filtro sigle non
            si applica. Se nella stessa cartella c&apos;è il foglio 1, vince quello.
          </li>
        </ul>
      </section>

      <section>
        <h3>3. I due filtri sulla tabella part number</h3>
        <ul>
          <li>
            <strong>Sigle.</strong> Il part number deve iniziare con una sigla
            della tab Sigle spare parts. SC1004 passa se esiste la sigla SC.
          </li>
          <li>
            <strong>Indici.</strong> La descrizione deve contenere un token della
            tab Indici dei ricambi, oppure il part number è uguale all&apos;indice
            (es. SC0059). Vince il token più specifico. Un indice vuoto non
            aggancia niente: il pezzo non entra.
          </li>
          <li>
            «Chain coupling» e «giunto» non vengono letti come catena di trasporto.
            Serve l&apos;indice del giunto.
          </li>
          <li>
            La sigla UCF dentro un carter, una protezione o un coperchio non è il
            pezzo UCF.
          </li>
        </ul>
      </section>

      <section>
        <h3>4. Distinta di configurazione, foglio 1</h3>
        <ul>
          <li>Catena di trasporto, in metri.</li>
          <li>Supporti della riga Bearing assembly.</li>
          <li>Sprinkler. I supporti e le piastre dello sprinkler non entrano.</li>
          <li>
            Porte explosion proof: solo i Bursting Panels. Telaio e cover restano
            fuori. La descrizione contiene PORTELL, così l&apos;indice della porta
            la riconosce.
          </li>
          <li>
            Scraper CT0003 solo sulla catena doppia (codice distinta CT). Sulla
            catena singola gli scraper non si elencano, nemmeno se il disegno li
            riporta.
          </li>
        </ul>
      </section>

      <section>
        <h3>5. Coclea</h3>
        <ul>
          <li>
            Dal foglio SPARE PARTS entrano giunto, catena e supporto completo,
            se il flag è S e la quantità è maggiore di zero.
          </li>
          <li>
            Il supporto TM resta una riga. Cuscinetti, ralla e tenute li aggiunge
            il listino, dalle celle gialle della scheda di quel modello.
          </li>
          <li>
            Se il modello della catena è solo la parola CHAIN, si tiene il testo
            della scheda, per esempio «Chain - L=-».
          </li>
          <li>Motori MR e sensori SE della scheda non sono ricambi di distinta: stanno nelle liste ML e SL.</li>
        </ul>
      </section>

      <section>
        <h3>6. Codice in offerta e gruppi</h3>
        <ul>
          <li>
            Se sull&apos;indice Spare parts list è SI, il codice mostrato è quello
            vendibile del listino. Se non c&apos;è, resta il codice della distinta
            e compare un avviso.
          </li>
          <li>
            Gestione Composto: le righe dello stesso modello si accorpano, per
            esempio i TM100CLC. Gestione Unico: una riga per part number.
          </li>
          <li>
            Con «gruppo cuscinetti», sotto l&apos;assieme si elencano i componenti
            gialli della scheda: cuscinetti, ralla, tenute. Ingrassatore e
            bulloni, se non sono gialli, non entrano. La scorta dell&apos;assieme
            resta vuota.
          </li>
          <li>
            I gruppi supporto si colorano a turno con #E5FFFF e #FFEFFF. Gli altri
            gruppi composti usano la tavolozza più scura.
          </li>
          <li>
            La descrizione segue la colonna struttura dell&apos;indice, se è
            compilata. Altrimenti si usa il testo della distinta.
          </li>
        </ul>
      </section>

      <section>
        <h3>7. Quantità</h3>
        <ul>
          <li>La quantità installata arriva dalla distinta.</li>
          <li>
            La scorta consigliata è il 10% dell&apos;installato, arrotondata per
            eccesso, minimo 1. Sull&apos;assieme del supporto resta vuota.
          </li>
          <li>
            Per la catena in metri o millimetri, se il disegno della commessa ha
            il chain ring, la metratura installata è quella del disegno. La scorta
            è il 10% arrotondato a un numero intero di maglie, usando il passo del
            disegno o, se manca, quello nel tipo catena.
          </li>
          <li>
            Pale e scraper letti dal disegno prendono la quantità del disegno. Un
            file con TP nel nome è una scheda tappeto e non si usa come disegno
            catena.
          </li>
        </ul>
      </section>

      <section>
        <h3>8. Motori e sensori</h3>
        <ul>
          <li>Stanno in due sezioni proprie, non dentro i ricambi di distinta.</li>
          <li>Motori: dalla lista ML collegata all&apos;offerta, solo i codici che iniziano con MR.</li>
          <li>
            Sensori: tutte le righe della lista SL. Se il codice non inizia con SE,
            la riga resta in offerta ed è evidenziata in giallo.
          </li>
        </ul>
      </section>

      <section>
        <h3>9. Tre colonne in coda</h3>
        <p>Si compilano dal tipo di componente. Se il tipo non è in tabella, le celle restano vuote.</p>
        <table className="rules-table">
          <thead>
            <tr>
              <th>Componente</th>
              <th>Giorni</th>
              <th>Priorità</th>
              <th>W / S</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Supporto TM</td><td>30</td><td>*</td><td>S</td></tr>
            <tr><td>Supporto SN, SNL, SNH, UKT, FN</td><td>20</td><td>**</td><td>S</td></tr>
            <tr><td>Supporto FL, TK-R e altri non in elenco</td><td></td><td></td><td></td></tr>
            <tr><td>Cuscinetto, bussola, ralla, tenuta, kit settori</td><td>20</td><td>***</td><td>W</td></tr>
            <tr><td>Catena di trasmissione</td><td>5</td><td>***</td><td>W</td></tr>
            <tr><td>Catena di trasporto, tappeto</td><td>60</td><td>***</td><td>W</td></tr>
            <tr><td>Giunto</td><td>30</td><td>*</td><td>W</td></tr>
            <tr><td>Pignone, corona</td><td>30</td><td>*</td><td>S</td></tr>
            <tr><td>Pala / scraper</td><td></td><td>***</td><td></td></tr>
            <tr><td>Motoriduttore</td><td>60</td><td>***</td><td>S</td></tr>
            <tr><td>Sensore</td><td>10</td><td>***</td><td>S</td></tr>
            <tr><td>Sensore Vega o Vib</td><td>30</td><td>***</td><td>S</td></tr>
            <tr><td>Sprinkler, porta explosion proof</td><td></td><td></td><td></td></tr>
          </tbody>
        </table>
      </section>

      <section>
        <h3>10. Excel</h3>
        <ul>
          <li>Il file grafico è il template SP OFFER: colori, bordi, colonne e loghi.</li>
          <li>Project riporta codice macchina e POS. del COC.</li>
          <li>L&apos;ultima riga di ogni commessa ha il bordo inferiore rosso.</li>
          <li>Il totale in alto è la somma della colonna importo, calcolata sulla scorta.</li>
        </ul>
      </section>
    </div>
  );
}
