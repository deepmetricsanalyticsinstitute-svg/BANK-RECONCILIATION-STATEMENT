import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { ReconciliationResult } from '../types';

const formatCurrency = (val: number) => val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const generateCSVContent = (result: ReconciliationResult): string => {
  let csv = "data:text/csv;charset=utf-8,";
  csv += "Status,Source,Date,Description,Amount,Type,Match ID,Match Reason\n";

  // Matches
  result.matches.forEach(m => {
    const reason = `"${m.reason.replace(/"/g, '""')}"`;
    m.bank.forEach(t => {
      csv += `Matched,Bank,${t.date},"${t.description.replace(/"/g, '""')}",${t.amount},${t.type},${m.id},${reason}\n`;
    });
    m.ledger.forEach(t => {
      csv += `Matched,Ledger,${t.date},"${t.description.replace(/"/g, '""')}",${t.amount},${t.type},${m.id},${reason}\n`;
    });
  });

  // Unmatched Bank
  result.unmatchedBank.forEach(t => {
    csv += `Unmatched,Bank,${t.date},"${t.description.replace(/"/g, '""')}",${t.amount},${t.type},,\n`;
  });

  // Unmatched Ledger
  result.unmatchedLedger.forEach(t => {
    csv += `Unmatched,Ledger,${t.date},"${t.description.replace(/"/g, '""')}",${t.amount},${t.type},,\n`;
  });

  return csv;
};

export const downloadCSV = (result: ReconciliationResult) => {
  const content = generateCSVContent(result);
  const encodedUri = encodeURI(content);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `reconciliation_report_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const downloadPDF = (result: ReconciliationResult) => {
  const doc = new jsPDF();

  // Header
  doc.setFontSize(20);
  doc.setTextColor(40);
  doc.text("Reconciliation Report", 14, 22);

  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);
  
  // Statistics Summary
  doc.setDrawColor(200);
  doc.line(14, 35, 196, 35);
  
  doc.setFontSize(12);
  doc.setTextColor(0);
  doc.text(`Match Rate: ${result.stats.matchRate.toFixed(1)}%`, 14, 45);
  
  const totalMatched = result.stats.matchedBankCount + result.stats.matchedLedgerCount;
  doc.text(`Total Matched Items: ${totalMatched}`, 14, 52);
  doc.text(`Unmatched Bank Items: ${result.stats.unmatchedBankCount}`, 80, 52);
  doc.text(`Unmatched Ledger Items: ${result.stats.unmatchedLedgerCount}`, 145, 52);

  let finalY = 60;

  // 1. Matches Table
  if (result.matches.length > 0) {
    doc.setFontSize(14);
    doc.text("Matched Groups", 14, finalY);
    
    const matchRows = result.matches.map(m => {
        const totalAmount = m.bank.reduce((sum, t) => sum + t.amount, 0);
        return [
            m.type.toUpperCase(),
            `${m.bank.length} Bank / ${m.ledger.length} Ledger`,
            formatCurrency(totalAmount),
            m.reason
        ];
    });

    autoTable(doc, {
        startY: finalY + 5,
        head: [['Type', 'Items', 'Total Amount', 'Reason']],
        body: matchRows,
        theme: 'striped',
        headStyles: { fillColor: [22, 163, 74] }, // Green
    });

    // @ts-ignore
    finalY = doc.lastAutoTable.finalY + 15;
  }

  // 2. Unmatched Bank
  if (result.unmatchedBank.length > 0) {
    doc.setFontSize(14);
    doc.text("Unmatched Bank Transactions", 14, finalY);
    
    const bankRows = result.unmatchedBank.map(t => [
        t.date,
        t.description,
        t.type,
        formatCurrency(t.amount)
    ]);

    autoTable(doc, {
        startY: finalY + 5,
        head: [['Date', 'Description', 'Type', 'Amount']],
        body: bankRows,
        theme: 'striped',
        headStyles: { fillColor: [37, 99, 235] }, // Blue
    });

    // @ts-ignore
    finalY = doc.lastAutoTable.finalY + 15;
  }

  // 3. Unmatched Ledger
  if (result.unmatchedLedger.length > 0) {
    doc.setFontSize(14);
    doc.text("Unmatched Ledger Transactions", 14, finalY);
    
    const ledgerRows = result.unmatchedLedger.map(t => [
        t.date,
        t.description,
        t.type,
        formatCurrency(t.amount)
    ]);

    autoTable(doc, {
        startY: finalY + 5,
        head: [['Date', 'Description', 'Type', 'Amount']],
        body: ledgerRows,
        theme: 'striped',
        headStyles: { fillColor: [234, 88, 12] }, // Orange
    });
  }

  doc.save(`reconciliation_report_${new Date().toISOString().split('T')[0]}.pdf`);
};
