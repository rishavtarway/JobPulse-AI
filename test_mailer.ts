import * as path from 'path';
import * as fs from 'fs';
import nodemailer from 'nodemailer';

const ATTACHMENTS = [
    { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
    { filename: 'RishavTarway_IIITB_InternshipCertificate.pdf', path: path.join(process.cwd(), 'RishavTarway_IIITB_InternshipCertificate.pdf') },
    { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
    { filename: 'SRIP_CompletionLetter Certificate2025_IIITB.pdf', path: path.join(process.cwd(), 'SRIP_CompletionLetter Certificate2025_IIITB.pdf') }
].filter(att => fs.existsSync(att.path));

async function main() {
    const mailOptions = {
        to: "test@example.com",
        subject: "Test Attachments",
        html: "<p>Hello</p>",
        attachments: ATTACHMENTS
    };

    let transporter = nodemailer.createTransport({ streamTransport: true });
    const result = await new Promise<Buffer>((resolve, reject) => {
        transporter.sendMail(mailOptions, (err, info) => {
            if (err) return reject(err);
            if (Buffer.isBuffer(info.message)) {
                return resolve(info.message);
            }
            const chunks: any[] = [];
            (info.message as any).on('data', (chunk: any) => chunks.push(chunk));
            (info.message as any).on('end', () => resolve(Buffer.concat(chunks)));
        });
    });

    console.log("Size:", result.length);
    const raw = result.toString('utf-8');
    console.log("Contains resume:", raw.includes('RishavTarway-Resume.pdf'));
}

main().catch(console.error);
