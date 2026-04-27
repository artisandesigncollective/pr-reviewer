import { LobClient } from 'lob'; // Hypothetical wrapper
import { DocumoClient } from 'documo'; // Hypothetical wrapper

/**
 * Sovereign Last-Mile Dispatcher
 * This utility handles the physical and digital delivery of legal packets.
 * It is the "Action" component of Phase 7.
 */

export interface DispatchRequest {
  pdfUrl: string;
  recipient: {
    name: string;
    address_line1: string;
    address_city: string;
    address_state: string;
    address_zip: string;
  };
  method: 'CERTIFIED_MAIL' | 'REGULAR_MAIL' | 'FAX';
  faxNumber?: string;
  metadata?: Record<string, string>;
}

export async function dispatchLegalPacket(req: DispatchRequest) {
  console.log(`[SOVEREIGN ACTION] Dispatching via ${req.method} to ${req.recipient.name}`);

  try {
    if (req.method === 'CERTIFIED_MAIL' || req.method === 'REGULAR_MAIL') {
      // Integration with Lob API
      // In production, this uses LOB_API_KEY from environment
      const lob = new LobClient(process.env.LOB_API_KEY!);
      
      const response = await lob.letters.create({
        description: `Legal Dispute: ${req.metadata?.caseId || 'Manual'}`,
        to: {
          name: req.recipient.name,
          address_line1: req.recipient.address_line1,
          address_city: req.recipient.address_city,
          address_state: req.recipient.address_state,
          address_zip: req.recipient.address_zip,
          address_country: 'US',
        },
        from: process.env.SOVEREIGN_RETURN_ADDRESS_ID!, // Fixed Paperclip return address
        file: req.pdfUrl,
        color: false,
        extra_service: req.method === 'CERTIFIED_MAIL' ? 'certified' : undefined,
      });

      return {
        success: true,
        trackingNumber: response.tracking_number,
        estimatedDelivery: response.expected_delivery_date,
        provider: 'LOB',
      };
    }

    if (req.method === 'FAX') {
      // Integration with Documo/mFax
      const fax = new DocumoClient(process.env.DOCUMO_API_KEY!);
      
      const response = await fax.send({
        recipientFax: req.faxNumber!,
        documentUrl: req.pdfUrl,
        coverPage: true,
        subject: `Legal Dispute: ${req.metadata?.caseId}`,
      });

      return {
        success: true,
        faxId: response.id,
        status: 'SENT',
        provider: 'DOCUMO',
      };
    }

    throw new Error('Unsupported dispatch method');
  } catch (error: any) {
    console.error(`[DISPATCH ERROR] ${error.message}`);
    return {
      success: false,
      error: error.message,
    };
  }
}
