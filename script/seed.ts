import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { customers, appointments } from "../shared/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

async function seed() {
  console.log("Seeding database...");

  // Insert customers
  const customerData = [
    {
      name: "Gerda Müller",
      address: "Lindenstraße 42, 10969 Berlin",
      avatar: "lady",
      needs: ["Mobility assistance", "Medication reminder"]
    },
    {
      name: "Hans Schmidt",
      address: "Bergmannstraße 12, 10961 Berlin",
      avatar: "man",
      needs: ["Companionship", "Light housekeeping"]
    },
    {
      name: "Elfriede Weber",
      address: "Gneisenaustraße 88, 10961 Berlin",
      avatar: "lady",
      needs: ["Grocery shopping", "Cooking help"]
    }
  ];

  const insertedCustomers = await db.insert(customers).values(customerData).returning();
  console.log(`✓ Inserted ${insertedCustomers.length} customers`);

  // Insert appointments for today
  const today = new Date().toISOString().split('T')[0];
  
  const appointmentData = [
    {
      customerId: insertedCustomers[0].id,
      type: "Customer Appointment",
      date: today,
      time: "09:00",
      durationPromised: 45,
      status: "completed"
    },
    {
      customerId: insertedCustomers[1].id,
      type: "Alltagsbegleitung",
      date: today,
      time: "11:30",
      durationPromised: 60,
      status: "scheduled"
    },
    {
      customerId: insertedCustomers[2].id,
      type: "Hauswirtschaft",
      date: today,
      time: "14:00",
      durationPromised: 90,
      status: "scheduled"
    },
    {
      customerId: insertedCustomers[0].id,
      type: "First Visit",
      date: today,
      time: "16:30",
      durationPromised: 60,
      status: "scheduled"
    }
  ];

  const insertedAppointments = await db.insert(appointments).values(appointmentData).returning();
  console.log(`✓ Inserted ${insertedAppointments.length} appointments`);

  console.log("Database seeded successfully!");
}

seed().catch((error) => {
  console.error("Error seeding database:", error);
  process.exit(1);
});
