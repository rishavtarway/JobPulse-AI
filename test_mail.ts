import nodemailer from 'nodemailer';
import path from 'path';

async function test() {
    let transporter = nodemailer.createTransport({ streamTransport: true });
    
    let options = {
        to: "test@example.com",
        subject: "test",
        html: "<p>Hello</p>",
        attachments: [{
            filename: 'RishavTarway-Resume.pdf',
            path: path.join(process.cwd(), 'RishavTarway-Resume.pdf')
        }]
    };
    
    console.log("sending mail...");
    transporter.sendMail(options, (err, info) => {
        if (err) return console.error(err);
        const chunks: any[] = [];
        const msg = info.message as NodeJS.ReadableStream;
        msg.on('data', chunk => chunks.push(chunk));
        msg.on('end', () => console.log("Done!", Buffer.concat(chunks).length));
        msg.on('error', err => console.log("Error!", err));
    });
}
test();
