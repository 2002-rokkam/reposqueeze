namespace java com.acme.billing
namespace py acme.billing

include "common.thrift"

typedef i64 Timestamp
const i32 MAX_ITEMS = 100

enum InvoiceStatus {
  DRAFT = 0,
  SENT = 1,
  PAID = 2
}

struct LineItem {
  1: required string sku,
  2: i32 quantity = 1,
  3: optional double unitPrice
}

struct Invoice {
  1: required string id,
  2: list<LineItem> items,
  3: InvoiceStatus status = InvoiceStatus.DRAFT,
  4: Timestamp issuedAt,
  5: map<string, string> metadata
}

exception InvoiceNotFound {
  1: string id
}

/** Billing operations. */
service BillingService extends common.BaseService {
  Invoice getInvoice(1: string id) throws (1: InvoiceNotFound notFound),
  void sendInvoice(1: string id),
  list<Invoice> listInvoices(1: i32 limit = MAX_ITEMS)
}
